const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const COMMON = path.join(ROOT, 'src/client/common')
const COMPONENTS = path.join(ROOT, 'src/client/components')
const WHITELIST = path.join(ROOT, 'src/test/unit-ci/defaults-whitelist.json')
const read = p => fs.readFileSync(p, 'utf8')

// 与 defaults-index-ssot.spec.js 的 A4 同源但独立复核：这里用 matchAll 重写一遍
// 导出名解析，避免「两处共用同一个有缺陷的实现」导致 209 / 重名护栏同时假绿。
// 全程只读源码字符串，不 import 任何域文件（constants.js 顶层读 window 且 import PNG）。

/**
 * 解析域文件导出名，三种声明形式都要覆盖：
 * ① export [async] const/let/var/function/class NAME
 * ② export default（记为 'default'）
 * ③ export { A, B as C } 块（可跨行），取 as 之后的导出名
 * 缺 ③ 会漏掉 db-session-const.js 末尾的 44 项集中导出。
 */
function parseExports (src) {
  const out = []
  const decl = /^[ \t]*export[ \t]+(?:async[ \t]+)?(?:const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)/gm
  for (const match of src.matchAll(decl)) {
    out.push(match[1])
  }
  if (/^[ \t]*export[ \t]+default\b/m.test(src)) {
    out.push('default')
  }
  const block = /^[ \t]*export[ \t]*\{([\s\S]*?)\}/gm
  for (const match of src.matchAll(block)) {
    for (const raw of match[1].split(',')) {
      const item = raw.replace(/\/\/[^\n]*/g, '').trim()
      if (!item) continue
      const parts = item.split(/[ \t]+as[ \t]+/)
      out.push(parts[parts.length - 1].trim())
    }
  }
  return out.filter(Boolean)
}

/** 递归收集组件目录下的 .js / .jsx（排除测试文件）。 */
function componentFiles () {
  const out = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(js|jsx)$/.test(full) && !/\.(spec|test)\.js$/.test(full)) {
        out.push(full)
      }
    }
  }
  walk(COMPONENTS)
  return out
}

describe('defaults domain registry: L2 域导出名登记护栏', () => {
  const whitelist = JSON.parse(read(WHITELIST))
  const byFile = new Map(
    whitelist.domainFiles.map(file => [file, parseExports(read(path.join(COMMON, file)))])
  )
  const allNames = [...byFile.values()].flat()

  test('① 7 个域文件都能解析出导出名（含末尾 export {} 块）', () => {
    assert.equal(whitelist.domainFiles.length, 7)
    for (const [file, names] of byFile) {
      assert.ok(names.length > 0, `${file} 未解析出任何导出名`)
    }
    assert.equal(allNames.length, 209, '域导出总数与审计基线一致')
  })

  test('② 导出名并集无重名（export * 防吞名）', () => {
    assert.equal(new Set(allNames).size, allNames.length)
    assert.equal(new Set(allNames).size, 209)
  })

  test('③ 组件不得同名重定义域导出名（语义分叉显式豁免）', () => {
    const exempt = new Set()
    for (const fork of whitelist.semanticForks) {
      if (Array.isArray(fork.names)) {
        fork.names.forEach(name => exempt.add(name))
      }
    }
    const forbidden = new Set(allNames.filter(name => !exempt.has(name)))
    const collisions = []
    const defRe = /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/gm
    for (const file of componentFiles()) {
      for (const match of read(file).matchAll(defRe)) {
        if (forbidden.has(match[1])) {
          collisions.push(`${path.relative(ROOT, file).split(path.sep).join('/')}:${match[1]}`)
        }
      }
    }
    assert.deepEqual(collisions, [], '组件内出现域导出名的同名重定义')
  })

  test('④ 语义分叉豁免有界且逐名可见', () => {
    const fork = whitelist.semanticForks.find(entry => entry.id === 'W2-7')
    assert.ok(fork, '组件局部同名分叉必须登记为 W2-7')
    assert.deepEqual(fork.names.slice().sort(), ['NA', 'isMac', 'modals', 'typeMap'])
    assert.equal(fork.names.includes('HIGHLIGHT_LIMITS'), false, '变异自证哨兵名不得被豁免')
    for (const name of fork.names) {
      const found = fork.files.some(file => {
        const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${name}[ \\t]*=`, 'm')
        return re.test(read(path.join(ROOT, file)))
      })
      assert.ok(found, `豁免名 ${name} 在所列组件里没有真实定义`)
    }
  })
})
