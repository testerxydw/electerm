const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const COMMON = path.join(ROOT, 'src/client/common')
const UNIT = path.join(ROOT, 'src/test/unit-ci')
const INDEX = path.join(COMMON, 'defaults.js')
const WHITELIST = path.join(UNIT, 'defaults-whitelist.json')
const read = p => fs.readFileSync(p, 'utf8')

// 全程只读源码字符串，绝不 import / require 索引或任何域文件：
// src/client/common/constants.js:9 顶层执行 window.et.packInfo，且 :6-8 import 三个 PNG，
// 在 node:test 进程里加载会直接抛错；defaults.js 本批次也不接 vite 打包链。
// 域文件发现必须用 RegExp.test()（任意位置搜索），不能用从头锚定的 match 语义，
// 否则 db-session-const.js / sync-payload-limit.js / theme-defaults.js 会被漏掉。
const DOMAIN_RE = /-(?:const|limits|limit|defaults|protocol)\.js$|^(?:constants|default-setting|term-flow|theme-defaults)\.js$/

/** 去掉整行注释与空行，只留可判定的代码行。 */
function indexCode (src) {
  return src
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .join('\n')
}

/** 按 domainFilePattern 动态发现同包域文件，索引自身显式排除。 */
function discoverDomainFiles () {
  return fs.readdirSync(COMMON)
    .filter(f => DOMAIN_RE.test(f) && f !== 'defaults.js')
    .filter(f => fs.statSync(path.join(COMMON, f)).isFile())
    .sort()
}

/**
 * 解析一个域文件的导出名：
 * ① export const / let / var / function / class NAME
 * ② export default（记为 'default'）
 * ③ 末尾 export { A, B as C } 块，取 as 之后的名字
 * 缺 ③ 会漏掉 db-session-const.js 末尾集中导出的 44 项。
 */
function parseExportNames (src) {
  const names = []
  const decl = /^[ \t]*export[ \t]+(?:async[ \t]+)?(?:const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = decl.exec(src)) !== null) {
    names.push(m[1])
  }
  if (/^[ \t]*export[ \t]+default\b/m.test(src)) {
    names.push('default')
  }
  const block = /^[ \t]*export[ \t]*\{([^}]*)\}/gm
  while ((m = block.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const item = part.trim()
      if (!item) continue
      const alias = item.split(/[ \t]+as[ \t]+/)
      names.push((alias.length > 1 ? alias[alias.length - 1] : alias[0]).trim())
    }
  }
  return names.filter(Boolean)
}

/** 递归收集 basename 为 defaults.js 的文件，用于「单索引」断言。 */
function findIndexFiles (dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      findIndexFiles(full, out)
    } else if (entry.name === 'defaults.js') {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'))
    }
  }
  return out
}

describe('defaults index: L3 唯一索引契约（只读源码，不加载模块）', () => {
  test('A1 索引只 re-export、零定义', () => {
    const src = read(INDEX)
    const code = indexCode(src)
    const lines = code.split('\n')
    assert.ok(lines.length > 0, 'index must not be empty')
    for (const line of lines) {
      assert.match(
        line,
        /^export\s+(?:\*\s+from|\{[^}]*\}\s+from)\s+'\.\/[^']+\.js'$/,
        `every line must be a pure re-export: ${line}`
      )
    }
    assert.doesNotMatch(code, /export\s+(?:const|let|var|function|class)\b/)
    assert.doesNotMatch(code, /^\s*(?:const|let|var)\s+\w+\s*=/m)
    assert.doesNotMatch(code, /\b\d{2,}\b|Object\.freeze/)
  })

  test('A2 域文件清单完整（新增域文件必须被索引）', () => {
    const discovered = discoverDomainFiles()
    const indexed = [...read(INDEX).matchAll(/from '\.\/([^']+\.js)'/g)]
      .map(m => m[1])
      .sort()
    assert.deepEqual(indexed, discovered, 'every discovered domain file must be re-exported by the index')

    const whitelist = JSON.parse(read(WHITELIST))
    assert.deepEqual(
      whitelist.domainFiles.slice().sort(),
      discovered,
      'whitelist.domainFiles, dynamic discovery and index targets must be the same set'
    )
    // 白名单里的发现规则必须与本 spec 内置规则同解，防止改 pattern 绕过 A2。
    const patternRe = new RegExp(whitelist.domainFilePattern)
    const fromWhitelist = fs.readdirSync(COMMON)
      .filter(f => patternRe.test(f) && f !== 'defaults.js')
      .filter(f => fs.statSync(path.join(COMMON, f)).isFile())
      .sort()
    assert.deepEqual(fromWhitelist, discovered, 'whitelist.domainFilePattern must discover the same files')
  })

  test('A3 索引不跨包、不引入 CJS', () => {
    const src = read(INDEX)
    assert.doesNotMatch(src, /\.\.\/\.\.\/app\/|src\/app|require\(|module\.exports/)
    const targets = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
    assert.ok(targets.length > 0, 'index must have re-export targets')
    for (const target of targets) {
      assert.ok(target.startsWith('./'), `re-export must stay in-package: ${target}`)
      assert.ok(target.endsWith('.js'), `re-export must target a JS module: ${target}`)
      assert.ok(fs.existsSync(path.join(COMMON, target)), `re-export target missing: ${target}`)
    }
  })

  test('A4 域文件间导出名不重名（export * 防吞名）', () => {
    const discovered = discoverDomainFiles()
    const names = []
    for (const file of discovered) {
      const own = parseExportNames(read(path.join(COMMON, file)))
      assert.ok(own.length > 0, `${file} must export at least one name`)
      names.push(...own)
    }
    assert.equal(
      new Set(names).size,
      names.length,
      'duplicate export names across domain files would be silently dropped by export *'
    )
  })

  test('A5 索引文件唯一（单索引决策，app 侧不建第二份）', () => {
    const found = findIndexFiles(path.join(ROOT, 'src/client'), [])
    findIndexFiles(path.join(ROOT, 'src/app/common'), found)
    assert.deepEqual(found.sort(), ['src/client/common/defaults.js'])
    assert.ok(fs.existsSync(INDEX))
    assert.equal(fs.existsSync(path.join(ROOT, 'src/app/common/defaults.js')), false)
  })
})
