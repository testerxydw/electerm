/**
 * 护栏：保住两条「静态看不出来」的教训，防止以后改回去。
 *
 * 1. node:test 的 suite hook 失败只报 cancelled、# fail 仍是 0；unit-ci 入口
 *    必须显式识别 hookFailed / cancelled 并透传非零退出码。
 *    同一条盲区的另一个变体：**suite 自身抛错**时 TAP 只有一行 suite 级
 *    `not ok`，`# fail` 与 `# cancelled` 都是 0、退出码也可能是 0（2026-11-10
 *    db-page-tree-filter.spec.js 的 T2 就这样被整轮当成全绿），因此入口必须
 *    自己数任意层级的 `not ok`，并据此把退出码拉成非零。
 * 2. widget-protocol 的临时树不能再软链回仓库 node_modules：安全删除垫片按
 *    realpath 判定 os.tmpdir() 豁免，指向仓库的软链会走回收站并抛 EISDIR。
 *    必须用 tmpdir 内的真实转发文件（AGENTS.md §1-2）。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8')

const RUNNER = path.join(REPO, 'src/build/bin/test-unit-ci.js')
// 入口自带 `require.main === module` 守卫，require 进来只拿判定函数，不跑测试
const { evaluateTestOutput } = require(RUNNER)

describe('unit-ci 入口：hookFailed / cancelled / suite 级 not ok 统计盲区护栏', () => {
  const pkg = JSON.parse(read('package.json'))
  const runner = read('src/build/bin/test-unit-ci.js')

  it('npm run test-unit-ci 走护栏入口而不是裸 node --test', () => {
    assert.equal(pkg.scripts['test-unit-ci'], 'node src/build/bin/test-unit-ci.js')
  })

  it('入口识别 hookFailed、cancelled、任意层级 not ok 并透传原始输出', () => {
    assert.match(runner, /failureType: 'hookFailed'/)
    // 计数走 TAP 汇总行；suite 级红靠任意层级的 not ok 行（含缩进）
    assert.ok(/output\.match\(new RegExp\(`\^# /.test(runner), 'TAP 汇总计数行要按名字解析')
    assert.ok(runner.includes('[ \\t]*not ok \\d+ - (.+)'), '要数任意层级（含缩进 suite 级）的 not ok 行')
    assert.ok(
      runner.includes('const code = !verdict.green && reportedCode === 0 ? 1 : reportedCode'),
      'node:test 报 not ok 却退出 0 时，入口必须自己给非零退出码'
    )
    assert.match(runner, /process\.exitCode = code/)
    assert.match(runner, /process\.stdout\.write\(res\.stdout/)
    assert.match(runner, /'--test'/)
  })

  it('入口默认展开 unit-ci 目录下全部 spec，并支持传参单跑', () => {
    assert.match(runner, /endsWith\('\.spec\.js'\)/)
    assert.match(runner, /process\.argv\.slice\(2\)/)
  })

  it('cwd 必须解析到仓库根（src/build/bin 上溯三层）', () => {
    assert.match(runner, /const REPO = path\.resolve\(__dirname, '\.\.\/\.\.\/\.\.'\)/)
  })

  it('只含 suite 级 not ok（# fail 0）的输出 → 判定非全绿', () => {
    const output = [
      '# Subtest: T2 metadata tree filter (real source)',
      '    not ok 2 - T2 metadata tree filter (real source)',
      '      ---',
      "      failureType: 'testCodeFailure'",
      "      error: 'visibleMetadata derivation not found in db-session.jsx'",
      '      ...',
      '# tests 14',
      '# pass 14',
      '# fail 0',
      '# cancelled 0'
    ].join('\n')
    const verdict = evaluateTestOutput(output)
    assert.equal(verdict.notOkCount, 1)
    assert.deepEqual(verdict.notOkTitles, ['T2 metadata tree filter (real source)'])
    // 正是这条盲区：TAP 汇总三件套全是 0
    assert.equal(verdict.fail, 0)
    assert.equal(verdict.cancelled, 0)
    assert.equal(verdict.hookFailed, false)
    assert.equal(verdict.green, false, 'suite 级 not ok 不进 # fail，必须由 notOk 计数抓出来')
  })

  it('全 ok 的 TAP 输出 → 判定全绿', () => {
    const output = [
      '# Subtest: T1 current-page row filter (real source)',
      '    # Subtest: empty keyword returns all rows',
      '    ok 1 - empty keyword returns all rows',
      '      ---',
      "      type: 'test'",
      '      ...',
      '    1..1',
      'ok 1 - T1 current-page row filter (real source)',
      '# tests 1',
      '# pass 1',
      '# fail 0',
      '# cancelled 0'
    ].join('\n')
    const verdict = evaluateTestOutput(output)
    assert.equal(verdict.notOkCount, 0)
    assert.equal(verdict.fail, 0)
    assert.equal(verdict.cancelled, 0)
    assert.equal(verdict.hookFailed, false)
    assert.equal(verdict.green, true)
  })
})

describe('widget-protocol 临时树：禁止指回仓库的目录软链', () => {
  const spec = read('src/test/unit-ci/widget-protocol.spec.js')

  it('不再 symlinkSync 仓库 node_modules（realpath 会让 tmpdir 豁免失效）', () => {
    assert.doesNotMatch(spec, /symlinkSync\(NM/)
    assert.doesNotMatch(spec, /mkdtempSync\(path\.join\(NM, '\.tmp-inject-'\)\)/)
  })

  it('用 tmpdir 内的真实转发文件命中仓库 electron 的 stub cache', () => {
    assert.match(spec, /const electronDir = path\.join\(root, 'node_modules', 'electron'\)/)
    assert.match(spec, /fs\.mkdirSync\(electronDir, \{ recursive: true \}\)/)
    assert.match(spec, /module\.exports = require\(\$\{JSON\.stringify\(electronPath\)\}\)/)
  })

  it('清理仍统一走 fs.rmSync 直删（AGENTS.md §1）', () => {
    assert.match(spec, /const removeTree = p => fs\.rmSync\(p, \{ recursive: true, force: true \}\)/)
  })

  it('历史遗留的旧软链树用不带垫片的干净进程直删，不进回收站', () => {
    assert.match(spec, /function removeTreeRaw \(p\)/)
    assert.match(spec, /delete env\.NODE_OPTIONS/)
    assert.match(spec, /lstatSync\(path\.join\(p, 'node_modules'\)\)\.isSymbolicLink\(\)/)
    assert.doesNotMatch(spec, /gio trash|rmw/)
  })
})
