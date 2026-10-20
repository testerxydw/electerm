// 会话顶栏信息段（T5-2d）契约守护
// 纯函数(formatRate/cleanAlgo)源码提取真值测试 —— jsx 无法被 node 直接 import
// 组件/接线/styl 走源码契约断言（对齐 db-engine-mark.spec.js 惯例）
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const srcRoot = path.resolve(__dirname, '../..')
const read = p => fs.readFileSync(path.join(srcRoot, p), 'utf8')

const compJsx = read('client/components/common/session-bar-status.jsx')
const controlJsx = read('client/components/session/session-control.jsx')
const controlStyl = read('client/components/session/session-control.styl')
const defaultSetting = read('app/common/default-setting.js')

// 从 jsx 源码提取顶层纯函数并求值（函数体零依赖，安全）
function extractFn (src, name) {
  const m = src.match(new RegExp('(export )?function ' + name + ' \\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))
  assert.ok(m, '源码中必须存在 function ' + name)
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0].replace(/^export /, '') + ')')()
}

const formatRate = extractFn(compJsx, 'formatRate')
const cleanAlgo = extractFn(compJsx, 'cleanAlgo')

describe('session-bar-status: formatRate 分档', () => {
  it('空值/负值归零', () => {
    assert.equal(formatRate(0), '0 B/s')
    assert.equal(formatRate(undefined), '0 B/s')
    assert.equal(formatRate(-5), '0 B/s')
  })
  it('B/s 档（<1024）', () => {
    assert.equal(formatRate(1), '1 B/s')
    assert.equal(formatRate(512), '512 B/s')
    assert.equal(formatRate(1023.4), '1023 B/s')
  })
  it('KB/s 档：10 以下保留 1 位小数，10 及以上取整', () => {
    assert.equal(formatRate(1024), '1.0 KB/s')
    assert.equal(formatRate(2048), '2.0 KB/s')
    assert.equal(formatRate(9728), '9.5 KB/s')
    assert.equal(formatRate(10240), '10 KB/s')
    assert.equal(formatRate(1024 * 300), '300 KB/s')
  })
  it('MB/s 档保留 1 位小数', () => {
    assert.equal(formatRate(1024 * 1024), '1.0 MB/s')
    assert.equal(formatRate(1572864), '1.5 MB/s')
  })
})

describe('session-bar-status: cleanAlgo', () => {
  it('去掉 @ 后缀（如 curve25519-sha256@libssh.org）', () => {
    assert.equal(cleanAlgo('curve25519-sha256@libssh.org'), 'curve25519-sha256')
  })
  it('无后缀原样返回；空值返回空串', () => {
    assert.equal(cleanAlgo('aes128-ctr'), 'aes128-ctr')
    assert.equal(cleanAlgo(''), '')
    assert.equal(cleanAlgo(undefined), '')
  })
})

describe('session-bar-status: 组件契约', () => {
  it('响应式契约：必须为 manate class 组件（render 读 store 自动追踪，反向：禁止纯函数组件直读 store）', () => {
    // 纯函数组件读 store 不触发 re-render（项目已知坑）：
    // 症状为速率只在父级偶发渲染时显示快照，切 tab 后消失
    assert.match(compJsx, /import \{ Component \} from 'manate\/react\/class-components'/)
    assert.match(compJsx, /export default class SessionBarStatus extends Component/)
    assert.doesNotMatch(compJsx, /export default function SessionBarStatus/)
  })
  it('无 tab/id 守卫直接返回 null', () => {
    assert.match(compJsx, /if \(!tab \|\| !tab\.id\) \{\s*\n\s*return null/)
  })
  it('显隐开关走 updateConfig 持久化（反向：禁止 localStorage 直写）', () => {
    assert.match(compJsx, /store\.updateConfig\(\{\s*\n\s*sessionBarInfoVisible: !visible/)
    assert.doesNotMatch(compJsx, /localStorage/, '持久化必须走 config，不得直写 localStorage')
  })
  it('兜底旧配置：!== false 视为可见', () => {
    assert.match(compJsx, /store\.config\.sessionBarInfoVisible !== false/)
  })
  it('三段显隐条件：算法/shell 版本/速率（保留式：有 traffic 即常显 0 B/s）', () => {
    assert.match(compJsx, /hasAlgo = !!\(info\.kex \|\| info\.cipherClientToServer\)/)
    assert.match(compJsx, /hasShellVersion = !!info\.shellVersion/)
    // 反向：禁止回到"无流量隐藏"旧判据（切 tab 后速率段消失的旧症状）
    assert.match(compJsx, /hasTraffic = !!traffic\s*\n/)
    assert.doesNotMatch(compJsx, /hasTraffic = !!traffic &&/)
  })
  it('tooltip 复用语言包现有 hide/show key（反向：不得引用不存在的新 key）', () => {
    assert.match(compJsx, /e\('hide'\)/)
    assert.match(compJsx, /e\('show'\)/)
    assert.doesNotMatch(compJsx, /hideSessionInfo|showSessionInfo/)
  })
  it('反向：组件内不得有裸色值', () => {
    assert.doesNotMatch(compJsx, /#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('session-bar-status: 接线契约', () => {
  it('session-control.jsx 引入公共组件并在 desktop return 调用 renderBarStatus', () => {
    assert.match(controlJsx, /import SessionBarStatus from '\.\.\/common\/session-bar-status'/)
    assert.match(controlJsx, /function renderBarStatus \(\) \{/)
    const desktopReturn = controlJsx.match(/\/\/ ---- desktop ----[\s\S]*$/)[0]
    assert.match(desktopReturn, /\{renderBarStatus\(\)\}/, 'desktop return 必须渲染信息段')
    // 反向：mobile 弹层不塞信息段（窄空间由用户按需展开）
    const mobileBlock = controlJsx.match(/\/\/ ---- mobile ----[\s\S]*?\/\/ ---- desktop ----/)[0]
    assert.doesNotMatch(mobileBlock, /renderBarStatus\(\)/)
  })
  it('default-setting.js 定义开关默认开', () => {
    assert.match(defaultSetting, /sessionBarInfoVisible: true/)
  })
})

describe('session-bar-status: styl 形态契约', () => {
  it('.session-bar-status 样式块存在且全 token（反向：无裸色值）', () => {
    assert.match(controlStyl, /\.session-bar-status\n/)
    assert.doesNotMatch(controlStyl, /#[0-9a-fA-F]{3,8}\b/, '颜色一律 token')
  })
  it('关键 token 引用：分隔线/弱字/上行绿/下行主色/过渡时长', () => {
    assert.match(controlStyl, /border-left 1px solid var\(--border\)/)
    assert.match(controlStyl, /\.seg-k\n\s*color var\(--text-dark\)/)
    assert.match(controlStyl, /\.seg-up\n\s*color var\(--success\)/)
    assert.match(controlStyl, /\.seg-down\n\s*color var\(--primary\)/)
    assert.match(controlStyl, /transition color var\(--dur-2\) var\(--ease\)/)
  })
})
