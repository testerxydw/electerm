// 自测脚本动窗口的归属契约：只准缩"自己这台实例"的窗口
//
// 起因（2026-11-04）：一次跨会话复跑忘了把 DISPLAY 转发给 db-workspace-shell-demo，
// 脚本按 process.env.DISPLAY 落到了用户的真桌面 `:0`，于是它那条"对每个同名窗口
// 试缩、谁跟着页面 innerWidth 变谁才是我的窗口"的兜底，把用户正在用的
// electerm [rdp] 会话窗口（2558×1439）缩到 1023 宽再还原。尺寸能还原，
// 真人看到的闪动还原不了。
//
// 钉住四件事（都只查代码，注释里写多少遍"我筛过了"都不算）：
//   1. 取窗口归属（_NET_WM_PID）
//   2. 核对该 pid 就是本实例（/proc/<pid>/cmdline 带同一个调试端口，或显式 --instance-pid）
//   3. 试缩循环只跑在筛过的列表上（不跑在 candidates/allWindows 上）
//   4. 筛空了就判红，绝不退回"盲试"
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SELF_TEST = path.join(__dirname, '../../..', 'self-test')

// 注释不算数：以前这里正是靠注释解释"为什么逐个试缩"，行为却没变
const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const violations = (src) => {
  const code = codeOf(src)
  if (!/windowsize/.test(code)) return []
  const out = []
  if (!/_NET_WM_PID/.test(code)) out.push('没取窗口归属进程（_NET_WM_PID）')
  if (!/\/proc\/|--instance-pid/.test(code)) out.push('没核对归属进程就是本实例（/proc/<pid>/cmdline 或 --instance-pid）')
  if (/for \(const id of (candidates|allWindows)\)/.test(code)) out.push('试缩循环跑在未筛过的窗口列表上')
  if (!/check\([^\n]*!!winId/.test(code)) out.push('认不出自己的窗口时没有判红（可能退回盲试）')
  return out
}

describe('自测脚本动窗口的归属契约', () => {
  const files = fs.readdirSync(SELF_TEST).filter(f => f.endsWith('.js'))

  test('动窗口的脚本只在归属筛过的窗口上试缩', () => {
    const hits = []
    for (const f of files) {
      const bad = violations(fs.readFileSync(path.join(SELF_TEST, f), 'utf8'))
      for (const v of bad) hits.push(f + ' :: ' + v)
    }
    assert.deepEqual(hits, [], '自测脚本不得缩不属于本实例的窗口')
  })

  test('守卫真的咬得住改造前的写法', () => {
    const before = [
      "const candidates = xdo('search', '--name', '^electerm').trim().split('\\n').filter(Boolean)",
      'let winId = null',
      'for (const id of candidates) {',
      "  xdo('windowsize', id, '1023', String(h0))",
      "  xdo('windowsize', id, String(w0), String(h0))",
      '}'
    ].join('\n')
    assert.ok(violations('/* 注释里全是 _NET_WM_PID 和 /proc/ */\n' + before).length >= 3,
      '改造前的写法必须被判违规（且注释不能替代码挡枪）')
    assert.deepEqual(violations('// windowsize 只出现在注释里\nconst x = 1'), [],
      '没真动窗口的脚本不该被牵连')
  })
})
