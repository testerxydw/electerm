/**
 * unit-ci 入口：跑 node:test，并把「# fail 0 但其实挂了」的情况显式报出来。
 *
 * node:test 有两种红不进 `# fail`，只看 `# fail 0` 会把整组未执行 / 整条挂掉的
 * 用例当成全绿：
 *
 * 1. suite 的 before/after hook 抛错（failureType: 'hookFailed'）：子测试只被标成
 *    cancelledByParent，TAP 汇总仍是 `# fail 0`，唯一线索是 `# cancelled` 和非零
 *    退出码（2026-11-09 widget-protocol.spec.js 的 EISDIR 就是这样被漏看的）。
 * 2. **suite 自身抛错**（describe 回调里 assert 失败，如 2026-11-10
 *    db-page-tree-filter.spec.js 的 T2）：TAP 只有一行 suite 级 `not ok`，
 *    `# fail` 与 `# cancelled` 都是 0，退出码也可能是 0 —— 所以闸门必须自己数
 *    任意层级的 `not ok` 行，否则「整条 suite 挂掉」等于没跑过。
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

// TAP 汇总里的计数行，如 `# fail 3` / `# cancelled 1`
function tapCount (output, name) {
  const m = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))
  return m ? Number(m[1]) : 0
}

// 任意层级的 `not ok`（含缩进的 suite 级行）。suite 抛错时只有这一行是红的，
// test 级计数全是 0，所以这些行就是「这条 suite 到底跑起来了没有」的唯一证据。
function notOkTitles (output) {
  const titles = []
  const re = /^[ \t]*not ok \d+ - (.+)$/gm
  let m
  while ((m = re.exec(output)) !== null) {
    titles.push(m[1].trim())
  }
  return titles
}

/**
 * 按 TAP 输出判定这次 unit-ci 是否全绿。
 * 纯函数，供 test-unit-ci-guard.spec.js 直接喂样例输出断言（不只钉源码文本）。
 *
 * `# TODO` 行单独归类（knownFailure*）：node:test 把「标了 todo 的用例失败」打印
 * 成 `not ok N - title # TODO reason`。它们**不进 `# fail`**，所以只看 `# fail`
 * 的人会以为绿——但我们不豁免它们：本项目的实证是「缺陷修好后探针没人摘」
 * （一轮里 6 条 TODO 探针 1 小时内 4 条过期，还在断言已被修掉的缺陷）。
 * 豁免 = 过期探针永远绿着，没人会去看一个绿的 todo。
 * 删探针的 diff 是可见的、评审能拦；豁免过期的探针是隐形的。选可见的坏。
 * 所以 green 必须同时要求 knownFailureCount === 0 且 todoCount === 0
 * （通过了还挂着 # TODO 的用例同样是谎言：承诺没做完，却做完了）。
 * @param {string} output node --test 的 stdout + stderr
 * @returns {{notOkCount: number, notOkTitles: string[],
 *   knownFailureCount: number, knownFailureTitles: string[],
 *   fail: number, cancelled: number, todo: number,
 *   hookFailed: boolean, green: boolean}}
 */
function evaluateTestOutput (output) {
  const text = String(output || '')
  const rawTitles = notOkTitles(text)
  const knownFailures = rawTitles.filter(title => /#\s*TODO\b/.test(title))
  const titles = rawTitles.filter(title => !/#\s*TODO\b/.test(title))
  const fail = tapCount(text, 'fail')
  const cancelled = tapCount(text, 'cancelled')
  const todo = tapCount(text, 'todo')
  const hookFailed = /failureType: 'hookFailed'/.test(text)
  return {
    notOkCount: titles.length,
    // 只留前 5 条：一次挂几百条时摘要要还能读
    notOkTitles: titles.slice(0, 5),
    knownFailureCount: knownFailures.length,
    knownFailureTitles: knownFailures.slice(0, 5),
    fail,
    cancelled,
    todo,
    hookFailed,
    green: titles.length === 0 && knownFailures.length === 0 &&
      todo === 0 && fail === 0 && cancelled === 0 && !hookFailed
  }
}

function main () {
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

  const verdict = evaluateTestOutput(`${res.stdout || ''}${res.stderr || ''}`)
  const reportedCode = typeof res.status === 'number' ? res.status : 1
  // node:test 存在「有 `not ok` 却退出码 0」的情形（suite 级失败不进 # fail），
  // 闸门自己补上非零退出码，否则 CI 与本地验收都看不见这次红。
  const code = !verdict.green && reportedCode === 0 ? 1 : reportedCode

  if (!verdict.green || code !== 0) {
    console.error(
      '[test-unit-ci] 非全绿：' +
      `notOk=${verdict.notOkCount} ` +
      `todoProbe=${verdict.knownFailureCount} ` +
      `todo=${verdict.todo} ` +
      `fail=${verdict.fail} ` +
      `cancelled=${verdict.cancelled} ` +
      `hookFailed=${verdict.hookFailed ? 'yes' : 'no'} ` +
      `exit=${reportedCode}`
    )
    if (verdict.notOkTitles.length) {
      console.error(`[test-unit-ci] not ok（前 ${verdict.notOkTitles.length} 条）：`)
      verdict.notOkTitles.forEach(title => console.error(`[test-unit-ci]   - ${title}`))
    }
    if (verdict.knownFailureCount) {
      console.error(`[test-unit-ci] todo 探针（前 ${verdict.knownFailureTitles.length} 条，同样阻断）：`)
      verdict.knownFailureTitles.forEach(title => console.error(`[test-unit-ci]   - ${title}`))
      console.error('[test-unit-ci] 规则：src/test/unit-ci/ 里不出现 todo:。缺陷修好 → 探针转正；没修完 → 让它红。')
    }
    if (verdict.cancelled || verdict.hookFailed) {
      console.error('[test-unit-ci] suite hook 失败不计入 # fail，必须按 exit code / cancelled 判定，不能只看 # fail 0')
    }
    if (verdict.notOkCount && verdict.fail === 0) {
      console.error('[test-unit-ci] suite 级 `not ok` 同样不计入 # fail（node:test 只统计 test 级失败），已按非全绿处理')
    }
    if (!verdict.notOkCount && verdict.fail === 0 && verdict.cancelled === 0 && !verdict.hookFailed) {
      console.error('[test-unit-ci] TAP 汇总未报告失败但退出码非 0，请检查上面原始输出')
    }
  }

  // 已知缺陷（todo 探针）单独播报：同样阻断，只是归类不同，方便分辨
  // 「1 条真红」还是「1 条待转正的探针」。
  if (verdict.knownFailureCount) {
    console.error(
      `[test-unit-ci] 另有 known-failure TODO 探针 ${verdict.knownFailureCount} 条（同样算非全绿）：`
    )
    verdict.knownFailureTitles.forEach(title => console.error(`[test-unit-ci]   - ${title}`))
  }

  process.exitCode = code
}

if (require.main === module) {
  main()
}

module.exports = { evaluateTestOutput }
