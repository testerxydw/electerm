/**
 * 护栏：保住两条「静态看不出来」的教训，防止以后改回去。
 *
 * 1. node:test 的 suite hook 失败只报 cancelled、# fail 仍是 0；unit-ci 入口
 *    必须显式识别 hookFailed / cancelled 并透传非零退出码。
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

describe('unit-ci 入口：hookFailed / cancelled 统计盲区护栏', () => {
  const pkg = JSON.parse(read('package.json'))
  const runner = read('src/build/bin/test-unit-ci.js')

  it('npm run test-unit-ci 走护栏入口而不是裸 node --test', () => {
    assert.equal(pkg.scripts['test-unit-ci'], 'node src/build/bin/test-unit-ci.js')
  })

  it('入口识别 hookFailed、cancelled、非零退出码并透传原始输出', () => {
    assert.match(runner, /failureType: 'hookFailed'/)
    assert.match(runner, /# cancelled \[1-9\]/)
    assert.match(runner, /# fail \[1-9\]/)
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
