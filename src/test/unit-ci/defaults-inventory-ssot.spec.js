const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SCRIPT = path.join(ROOT, 'src/build/bin/inventory-defaults.js')

/** 以子进程跑 --json：脚本是 CLI，不 require 它，避免校验与实现同源。 */
function run () {
  const out = execFileSync(process.execPath, [SCRIPT, '--json'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return JSON.parse(out)
}

// 独立复算口径 S（§1.2）。刻意换一种正则写法与遍历实现，
// 使「脚本把返回值写死 / 漏扫目录」能被 ③ 直接发现。
const NAME_RE = /^[\t ]*(?:export[\t ]+)?(?:const|module\.exports\.|exports\.)[\t ]*([A-Z][A-Z0-9_]{2,})[\t ]*=[\t ]*(?:-?\d|['"[{]|true\b|false\b|null\b|Object\.freeze\b)/
const UPPER_RE = /MAX|LIMIT|DEFAULT|THRESHOLD|TIMEOUT|CAP|MIN|INTERVAL|BUDGET/

function recount () {
  const files = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|jsx)$/.test(full) && !/\.(spec|test)\.js$/.test(full)) files.push(full)
    }
  }
  ;['src/app', 'src/client'].forEach(dir => walk(path.join(ROOT, dir)))

  const hit = new Set()
  const byDir = {}
  let total = 0
  let upperClass = 0
  for (const file of files) {
    const rel = path.relative(ROOT, file)
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(NAME_RE)
      if (!match) continue
      total++
      hit.add(rel)
      if (UPPER_RE.test(match[1])) upperClass++
      const key = rel.split(path.sep).slice(0, 3).join('/')
      byDir[key] = (byDir[key] || 0) + 1
    }
  }
  return { total, files: hit.size, upperClass, byDir }
}

describe('defaults inventory: 口径 S 盘点脚本契约（T03）', () => {
  test('① 脚本存在且以 CLI 方式可运行', () => {
    assert.ok(fs.existsSync(SCRIPT), 'inventory-defaults.js 必须存在')
    // 脚本位于 src/build/bin，天然不会被 test-unit-ci.js 的 *.spec.js 收录。
    assert.equal(path.basename(SCRIPT).endsWith('.spec.js'), false)
    assert.ok(run().total > 0, '--json 必须产出可解析的统计结果')
  })

  test('② 两次重跑输出逐字一致（只读、无副作用）', () => {
    assert.deepEqual(run(), run())
  })

  test('③ 统计值与源码独立复算一致（防脚本写死返回值）', () => {
    const out = run()
    const own = recount()
    assert.equal(out.total, own.total, 'TOTAL 偏离源码复算')
    assert.equal(out.files, own.files, 'FILES 偏离源码复算')
    assert.equal(out.upperClass, own.upperClass, 'UPPER_CLASS 偏离源码复算')
    assert.deepEqual(out.byDir, own.byDir, 'BY DIR 偏离源码复算')
  })

  test('④ 三大热点集合稳定（顺序不作判据）', () => {
    const byDir = run().byDir
    const top3 = Object.entries(byDir)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(entry => entry[0])
      .sort()
    assert.deepEqual(top3, ['src/app/lib', 'src/client/common', 'src/client/components'])
  })

  test('⑤ 输出结构固定，绝对值只作量级参考（不作验收判据）', () => {
    const out = run()
    assert.deepEqual(
      Object.keys(out).sort(),
      ['byDir', 'conflictNames', 'conflicts', 'files', 'total', 'upperClass']
    )
    assert.ok(out.total > 500 && out.total < 3000, '常量定义行数量级异常')
    assert.ok(out.files > 100 && out.files < out.total)
    assert.ok(out.upperClass > 0 && out.upperClass < out.total)
    assert.ok(out.conflictNames.length > 0)
    assert.deepEqual(out.conflictNames, out.conflicts.map(item => item.name))
  })
})
