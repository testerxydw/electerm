/**
 * T5-4f 会话录制 UI 契约测试（顶栏三态 / 右键归并）。
 * jsx 不能在 Node 环境直接 import，按源码正则校验调用形式与结构。
 */
const assert = require('node:assert/strict')
const { it } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '../../')
const read = p => readFileSync(join(ROOT, p), 'utf8')

const controlJsx = read('client/components/session/session-control.jsx')
const sessionJsx = read('client/components/session/session.jsx')
const indicatorJsx = read('client/components/common/session-rec-indicator.jsx')
const termLogJs = read('client/components/terminal/mixins/term-log.jsx')
const contextMenuJs = read('client/components/terminal/mixins/term-context-menu.jsx')

it('T5-4f 顶栏三态: 未录 Play 开始 / 录制中 Stop+Pause / 暂停中 Stop+Play', () => {
  assert.match(controlJsx, /PauseCircleFilled/)
  assert.match(controlJsx, /recPaused/)
  assert.match(controlJsx, /toggleSessionRecordPause/, '暂停/继续必须走 store 单一入口')
  assert.match(
    controlJsx,
    /recPaused\s*\n\s*\?[\s\S]*?PlayCircleFilled[\s\S]*?:[\s\S]*?PauseCircleFilled/,
    '暂停态必须显示继续图标'
  )
  assert.match(sessionJsx, /recPaused=\{!!rec\?\.paused\}/)
  assert.match(
    sessionJsx,
    /toggleSessionRecordPause=\{\(\) => window\.store\.toggleSessionRecordPause\(this\.props\.tab\.id\)\}/
  )
  // 浮层暂停态显示 Paused 时长
  assert.match(indicatorJsx, /paused \? `Paused \$\{formatDuration\(now - startTime\)\}` : 'REC'/)
  assert.match(indicatorJsx, /\(paused \? ' paused' : ''\)/)
})

it('T5-4f 右键归并: onRecord 打开终端日志页, 不再直接弹保存框', () => {
  assert.match(termLogJs, /onRecord \(\) \{\s*\n\s*window\.store\.openInfoPanel\(\)/)
  assert.doesNotMatch(termLogJs, /openLogSaveDialog\('record'\)/, '右键不得再直接开保存框')
  assert.doesNotMatch(termLogJs, /onStopRecord/, '停止入口收敛到页面/顶栏')
  // onSaveTerminalLog 保持不动（导出当前缓冲区仍走保存框）
  assert.match(
    termLogJs,
    /async onSaveTerminalLog \(\) \{\s*\n\s*const filePath = await this\.openLogSaveDialog\('saveTerminalLogToFile'\)/
  )
  // 菜单项固定 onRecord, 不再按旧 term-log 状态切换
  assert.match(
    contextMenuJs,
    /key: 'onRecord',\s*\n\s*icon: <iconsMap\.PlayCircleFilled \/>,\s*\n\s*label: e\('record'\)/
  )
  assert.doesNotMatch(contextMenuJs, /onStopRecord/)
})
