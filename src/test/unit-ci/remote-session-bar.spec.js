// 顶栏统一（N1/N2）· 远程会话顶栏的显示层契约
//
// 背景（doc/分析-远程会话顶栏差异与统一-2026-10-30.md）：SessionShell 只统一了
// "怎么摆"（controlLeft/controlRight 两个自由槽位），没有统一"摆什么"，于是
// RDP/VNC/SPICE 三端的顶栏在 2024-05 ~ 2026-04 各自长成了三个样子：连接信息格式
// 不一致、图标字号不一致、VNC 选屏有两个入口、VNC 会话内改不了缩放。
//
// 纯函数部分覆盖格式规则；尾段是源码字符串契约 —— 格式对了但组件没接线，等于没做。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const loadMod = () => import('../../client/common/remote-display.js')

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * 词条能不能取到：window.translate 缺 key 时会回落到 capitalizeFirstLetter(key)，
 * 界面就裸显 ScaleViewport。两个补给通道都算：npm 语言包，以及仓库内
 * src/app/common/locales-extra.js（src/app/lib/locales.js 运行时合并）。
 */
const hasKey = (key) => {
  if (read('src/app/common/locales-extra.js').includes(`${key}:`)) {
    return true
  }
  const pack = path.join(ROOT, 'node_modules/@electerm/electerm-locales/dist/cjs')
  if (!fs.existsSync(pack)) {
    // 未安装依赖的环境不拦，避开环境差异带来的假失败
    return true
  }
  return ['en_us.js', 'zh_cn.js'].some((f) => {
    const p = path.join(pack, f)
    return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(`${key}:`)
  })
}

describe('formatConnInfo 连接信息格式', () => {
  test('字段齐全：user@host:port', async () => {
    const { formatConnInfo } = await loadMod()
    const info = formatConnInfo({
      name: 'Desktop-1',
      username: 'root',
      host: '10.0.0.8',
      port: 5901
    })
    assert.equal(info.conn, 'root@10.0.0.8:5901')
    assert.equal(info.name, 'Desktop-1')
  })

  test('没有用户名就不渲染 @：旧 VNC 会拼出 "@host:port"', async () => {
    const { formatConnInfo } = await loadMod()
    assert.equal(formatConnInfo({ host: 'h', port: 5900 }).conn, 'h:5900')
    assert.equal(formatConnInfo({ username: '', host: 'h', port: 5900 }).conn, 'h:5900')
    assert.equal(formatConnInfo({ username: null, host: 'h', port: 5900 }).conn, 'h:5900')
    assert.doesNotMatch(formatConnInfo({ host: 'h', port: 5900 }).conn, /@/)
  })

  test('没有端口就不渲染 :；0 / 空 / 非数字都视为未指定', async () => {
    const { formatConnInfo } = await loadMod()
    assert.equal(formatConnInfo({ username: 'u', host: 'h' }).conn, 'u@h')
    assert.equal(formatConnInfo({ username: 'u', host: 'h', port: 0 }).conn, 'u@h')
    assert.equal(formatConnInfo({ username: 'u', host: 'h', port: '' }).conn, 'u@h')
    assert.equal(formatConnInfo({ username: 'u', host: 'h', port: 'abc' }).conn, 'u@h')
    assert.doesNotMatch(formatConnInfo({ username: 'u', host: 'h' }).conn, /:/)
  })

  test('数字端口照样拼得出来，空白被 trim', async () => {
    const { formatConnInfo } = await loadMod()
    assert.equal(formatConnInfo({ username: ' u ', host: ' h ', port: 3389 }).conn, 'u@h:3389')
  })

  test('什么都没传：name 与 conn 都是空串，组件据此不渲染节点', async () => {
    const { formatConnInfo } = await loadMod()
    assert.deepEqual(formatConnInfo(), { name: '', conn: '' })
    assert.deepEqual(formatConnInfo({}), { name: '', conn: '' })
  })

  test('只有桌面名时 conn 为空（不会补出半个 host）', async () => {
    const { formatConnInfo } = await loadMod()
    const info = formatConnInfo({ name: 'X' })
    assert.equal(info.name, 'X')
    assert.equal(info.conn, '')
  })
})

describe('顶栏接线（N1）', () => {
  const files = {
    rdp: 'src/client/components/rdp/rdp-session.jsx',
    spice: 'src/client/components/spice/spice-session.jsx'
  }

  test('接入 SessionInfo 的会话不再有手拼字符串', () => {
    for (const rel of Object.values(files)) {
      const src = read(rel)
      assert.match(src, /import SessionInfo from '\.\.\/common\/session-info'/, rel)
      assert.match(src, /<SessionInfo/, rel)
      assert.doesNotMatch(src, /\{username\}@\{host\}:\{port\}/, rel)
    }
  })

  test('SessionInfo 走纯函数，不自己拼格式', () => {
    const src = read('src/client/components/common/session-info.jsx')
    assert.match(src, /formatConnInfo/)
    assert.doesNotMatch(src, /username\}@/)
  })

  test('浮层菜单里的重复选屏入口已删除', () => {
    const float = read('src/client/components/common/remote-float-control.jsx')
    assert.doesNotMatch(float, /Select Screen|DesktopOutlined/)
    assert.doesNotMatch(float, /screens\.length/)
  })

  test('顶栏图标字号统一在共享壳里，RDP 不再自己写 font-size', () => {
    const shell = read('src/client/components/common/session-shell.styl')
    assert.match(shell, /\.remote-session-control-left\n\.remote-session-control-right/)
    assert.match(shell, /font-size 16px/)
    const rdpStyl = read('src/client/components/rdp/rdp.styl')
    assert.doesNotMatch(rdpStyl, /font-size/, '字号该由共享壳给，不该各端自己写')
  })
})

describe('顶栏接线 · VNC（N1）', () => {
  const vnc = read('src/client/components/vnc/vnc-session.jsx')

  test('VNC 也改用 SessionInfo，带远端桌面名', () => {
    assert.match(vnc, /import SessionInfo from '\.\.\/common\/session-info'/)
    assert.match(vnc, /<SessionInfo\n\s*name=\{name\}/)
    assert.doesNotMatch(vnc, /<b>\{name\}<\/b>/)
    assert.doesNotMatch(vnc, /\{username\}@\{host\}:\{port\}/)
  })

  test('选屏只剩顶栏左侧一个入口', () => {
    const control = vnc.slice(vnc.indexOf('getControlProps'), vnc.indexOf('renderScreensSelect'))
    assert.doesNotMatch(control, /screens/, 'getControlProps 不该再把 screens 交给浮层')
    assert.doesNotMatch(control, /onSelectScreen/)
    assert.match(vnc, /renderScreensSelect/, '左侧 Select 必须保留')
  })
})

describe('VNC 会话内缩放（N2）', () => {
  const vnc = read('src/client/components/vnc/vnc-session.jsx')

  test('缩放走三层优先级：本机记忆 > 书签(含 profile) > 默认开', () => {
    assert.match(vnc, /resolveScaleViewport\(/)
    assert.match(vnc, /`vnc-scale-view-\$\{host\}`/)
    assert.match(vnc, /ls\.getItemJSON\(scaleViewportLsKey\(props\.tab\?\.host\), null\)/)
    assert.match(vnc, /window\.store\.applyProfile\(deepCopy\(props\.tab \|\| \{\}\)\)\.scaleViewport/)
  })

  test('栏内开关 + 即时生效 + 首连也用决策值', () => {
    assert.match(vnc, /<SwitchLabel/)
    assert.match(vnc, /label: window\.translate\('scaleViewport'\)/)
    // setState 回调里重排，不重连；appliedFit 判等挡住重复写 setter
    assert.match(vnc, /setState\(\{\s*scaleViewport: v\s*\}, this\.updateViewLayout\)/)
    assert.match(vnc, /scaleViewport: this\.state\.scaleViewport/, 'vncOpts 不能再读 tab 字段')
    assert.match(vnc, /return !!this\.state\.scaleViewport/, 'getFit 由决策后的 state 驱动')
  })

  test('全屏强制 fit，开关置灰以免显示与实际不符', () => {
    assert.match(vnc, /checked: this\.getFit\(\)/)
    assert.match(vnc, /disabled: !!this\.props\.fullscreen/)
    assert.match(vnc, /if \(this\.props\.fullscreen\) \{\s*return true/)
  })

  test('栏内开关的词条能取到（npm 语言包或补词通道，否则 UI 裸显 key）', () => {
    assert.ok(hasKey('scaleViewport'), 'scaleViewport')
    // 上一轮 R6 补的分辨率词条不能丢
    assert.ok(hasKey('resolutionAuto'), 'resolutionAuto')
  })
})
