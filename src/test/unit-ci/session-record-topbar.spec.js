// T5-4d 录制开关上顶栏契约守护
// 拦截：按钮被移除、manate 追踪链断裂(recording prop 不再来自父级 recState)、
//       回调改直连 store(绕过 session.jsx 追踪点)、图标/文案与右键菜单不一致
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const clientRoot = path.resolve(__dirname, '../../client')
const read = p => fs.readFileSync(path.join(clientRoot, p), 'utf8')

const controlJsx = read('components/session/session-control.jsx')
const sessionJsx = read('components/session/session.jsx')

describe('session-record-topbar: session-control.jsx 契约', () => {
  it('renderRecordIcon 存在, active 态绑定 recording prop', () => {
    assert.match(controlJsx, /function renderRecordIcon \(\)/,
      'renderRecordIcon 缺失')
    const seg = controlJsx.slice(
      controlJsx.indexOf('function renderRecordIcon'),
      controlJsx.indexOf('function renderWrapIcon')
    )
    assert.match(seg, /active: recording/, 'active 态必须绑定 recording prop')
    assert.match(seg, /onClick: toggleSessionRecord/, 'onClick 必须走 props 回调')
  })

  it('图标与右键菜单同款: 录制中 StopOutlined, 未录 PlayCircleFilled', () => {
    const seg = controlJsx.slice(
      controlJsx.indexOf('function renderRecordIcon'),
      controlJsx.indexOf('function renderWrapIcon')
    )
    assert.match(seg, /recording \? <StopOutlined/, '录制中应为 StopOutlined')
    assert.match(seg, /: <PlayCircleFilled/, '未录应为 PlayCircleFilled')
  })

  it('文案复用 locales 既有 key: record / stopRecord', () => {
    const seg = controlJsx.slice(
      controlJsx.indexOf('function renderRecordIcon'),
      controlJsx.indexOf('function renderWrapIcon')
    )
    assert.match(seg, /e\(recording \? 'stopRecord' : 'record'\)/)
  })

  it('桌面栏与移动端 extraIcons 均已挂载', () => {
    const desktop = controlJsx.slice(controlJsx.indexOf('// ---- desktop'))
    assert.match(desktop, /\{renderRecordIcon\(\)\}/, '桌面栏未挂载')
    const mobile = controlJsx.slice(controlJsx.indexOf('// ---- mobile'), controlJsx.indexOf('// ---- desktop'))
    assert.match(mobile, /\{renderRecordIcon\(\)\}/, '移动端 extraIcons 未挂载')
  })
})

describe('session-record-topbar: session.jsx 追踪链契约', () => {
  it('recording prop 来自父级 render 读 recState (manate 追踪点)', () => {
    // T5-4c 已确立的模式: 函数组件自身读 store 不触发 re-render,
    // 必须由 session.jsx render 读取后以 prop 下传
    assert.match(sessionJsx, /recording=\{!!rec\}/,
      'recording prop 必须来自 render 里的 rec 变量')
    assert.match(sessionJsx, /const rec = window\.store\.recState\[this\.props\.tab\.id\]/,
      '父级 render 未读 recState, 顶栏按钮开/停后将不刷新')
  })

  it('回调走 store.toggleSessionRecord (与右键菜单/浮层同一入口)', () => {
    assert.match(sessionJsx, /toggleSessionRecord=\{\(\) => window\.store\.toggleSessionRecord\(this\.props\.tab\.id\)\}/)
  })
})
