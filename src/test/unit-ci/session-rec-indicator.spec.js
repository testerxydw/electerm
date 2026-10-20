// REC 指示浮层 (T5-4c) 契约守护
// 拦截: manate 追踪丢失(父级不读 recState 则开/停录不刷新)、
// 非终端页误渲染、动画无 reduced-motion 兜底、裸色值
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const srcRoot = path.resolve(__dirname, '../..')
const read = p => fs.readFileSync(path.join(srcRoot, p), 'utf8')

const compJsx = read('client/components/common/session-rec-indicator.jsx')
const compStyl = read('client/components/common/session-rec-indicator.styl')
const sessionJsx = read('client/components/session/session.jsx')

describe('rec-indicator: 组件契约', () => {
  it('recording 为假直接返回 null (不录制时零 DOM)', () => {
    assert.match(compJsx, /if \(!recording\) \{\s*\n\s*return null/)
  })

  it('点击停止走 store.toggleSessionRecord(tabId) (反向: 不直接操作 recState/文件)', () => {
    assert.match(compJsx, /onClick=\{\(\) => window\.store\.toggleSessionRecord\(tabId\)\}/)
    // 反向: 不得出现真实调用 (注释提及 recState 不算)
    assert.doesNotMatch(compJsx, /recState\[|appendRecFile\(|createRecordFile\(/)
  })

  it('tooltip 复用语言包现有 stopRecord key, 展示落盘路径', () => {
    assert.match(compJsx, /e\('stopRecord'\)/)
    assert.match(compJsx, /recPath/)
  })

  it('反向: 组件内不得有裸色值', () => {
    assert.doesNotMatch(compJsx, /#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('rec-indicator: styl 形态契约', () => {
  it('终端区右上 absolute 胶囊', () => {
    assert.match(compStyl, /\.session-rec-indicator\n\s*position absolute\s*\n\s*top 6px\s*\n\s*right 10px/)
    assert.match(compStyl, /border-radius var\(--radius-pill\)/)
  })

  it('颜色一律 token (--error 系, 反向: 无裸色值)', () => {
    assert.match(compStyl, /background var\(--error\)/)
    assert.doesNotMatch(compStyl, /#[0-9a-fA-F]{3,8}\b/)
  })

  it('红点闪烁动画 + prefers-reduced-motion 兜底', () => {
    assert.match(compStyl, /animation rec-blink/)
    assert.match(compStyl, /@keyframes rec-blink/)
    assert.match(compStyl, /@media \(prefers-reduced-motion: reduce\)\s*\n\s*\.session-rec-indicator \.rec-dot\s*\n\s*animation none/)
  })
})

describe('rec-indicator: session.jsx 接线契约', () => {
  it('render 读 recState (manate 追踪), 开/停录触发重渲染', () => {
    const renderBlock = sessionJsx.match(/render \(\) \{\s*\n\s*const \{ pane \}[\s\S]*$/)[0]
    assert.match(renderBlock, /window\.store\.recState\[this\.props\.tab\.id\]/)
  })

  it('非终端类型守卫: 数据库/桌面/网页页不渲染浮层', () => {
    const renderBlock = sessionJsx.match(/render \(\) \{\s*\n\s*const \{ pane \}[\s\S]*$/)[0]
    assert.match(renderBlock, /this\.isNotTerminalType\(\)\s*\n\s*\? null/)
  })

  it('<SessionRecIndicator> 挂在 SessionControl 之后的根容器内', () => {
    assert.match(sessionJsx, /import SessionRecIndicator from '\.\.\/common\/session-rec-indicator'/)
    assert.match(sessionJsx, /\{recIndicator\}/)
    // 反向: SessionRecIndicator 不得渲染在 isNotTerminalType 分支内 (renderTerminals)
    assert.doesNotMatch(sessionJsx, /<SessionRecIndicator[^>]*\/>\s*\n\s*\)\s*\n\s*\}\s*\n\s*if \(type === terminalWebType\)/)
  })
})
