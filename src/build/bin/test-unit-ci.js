/**
 * unit-ci 入口：跑 node:test，并把「# fail 0 但其实挂了」的情况显式报出来。
 *
 * node:test 的 suite before/after hook 抛错（failureType: 'hookFailed'）时，
 * 子测试只被标成 cancelledByParent，TAP 汇总仍是 `# fail 0`；唯一线索是
 * `# cancelled` 和非零退出码。只看 # fail 会把整组未执行的用例当成全绿
 * （2026-11-09 widget-protocol.spec.js 的 EISDIR 就是这样被漏看的）。
 *
 * 这里不改变 node:test 的行为，只透传输出与退出码，再补一段醒目的失败摘要。
 * 用法：
 *   npm run test-unit-ci                         # 全部 *.spec.js
 *   node src/build/bin/test-unit-ci.js <file>    # 单跑指定 spec
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '../../..')
const unitDir = path.join(REPO, 'src/test/unit-ci')
const patterns = process.argv.length > 2
  ? process.argv.slice(2)
  : fs.readdirSync(unitDir)
    .filter(name => name.endsWith('.spec.js'))
    .sort()
    .map(name => path.join('src/test/unit-ci', name))

const res = spawnSync(
  process.execPath,
  ['--experimental-detect-module', '--test', ...patterns],
  {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  }
)

process.stdout.write(res.stdout || '')
process.stderr.write(res.stderr || '')

const output = `${res.stdout || ''}${res.stderr || ''}`
const failed = /# fail [1-9]/.test(output)
const cancelled = /# cancelled [1-9]/.test(output)
const hookFailed = /failureType: 'hookFailed'/.test(output)
const code = typeof res.status === 'number' ? res.status : 1

if (failed || cancelled || hookFailed || code !== 0) {
  const parts = [
    failed ? 'fail>0' : 'fail=0',
    cancelled ? 'cancelled>0' : 'cancelled=0',
    hookFailed ? 'hookFailed' : 'no-hookFailed',
    `exit=${code}`
  ]
  console.error(`[test-unit-ci] 非全绿：${parts.join(' ')}`)
  if (cancelled || hookFailed) {
    console.error('[test-unit-ci] suite hook 失败不计入 # fail，必须按 exit code / cancelled 判定，不能只看 # fail 0')
  }
  if (!failed && !cancelled && !hookFailed) {
    console.error('[test-unit-ci] TAP 汇总未报告失败但退出码非 0，请检查上面原始输出')
  }
}

process.exitCode = code
