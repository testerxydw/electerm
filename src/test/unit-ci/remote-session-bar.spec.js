// 顶栏统一（N1 / N2 / N3）· 远程会话顶栏的显示层与条目契约
//
// 背景（doc/分析-远程会话顶栏差异与统一-2026-10-30.md）：SessionShell 原来只统一了
// "怎么摆"（controlLeft/controlRight 两个自由槽位），没有统一"摆什么"，于是
// RDP/VNC/SPICE 三端的顶栏在 2024-05 ~ 2026-04 各自长成了三个样子：连接信息格式
// 不一致、图标字号不一致、VNC 选屏有两个入口、VNC 会话内改不了缩放。
// N1/N2 收了格式与开关，N3 把"摆什么"也交给共享壳：左 = 重连｜栏内条目｜信息，
// 右 = 全屏｜⋮。栏内条目（displayItems）含显示控件——分辨率/选屏 Select 与缩放
// 开关，2026-11-03 决定不收进 ⋮（先看得到才决定改不改），但一律用小尺寸，
// 保证 32px 的行盒装得下；⋮ 只是动作菜单，不是设置页。
//
// 纯函数部分覆盖格式规则；尾段是源码字符串契约 —— 格式对了但组件没接线，等于没做。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const loadMod = () => import('../../client/common/remote-display.js')

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const SHELL = read('src/client/components/common/session-shell.jsx')
const FLOAT = read('src/client/components/common/remote-float-control.jsx')
const rdp = read('src/client/components/rdp/rdp-session.jsx')
const vnc = read('src/client/components/vnc/vnc-session.jsx')
const spice = read('src/client/components/spice/spice-session.jsx')
const sessions = { rdp, vnc, spice }

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

/**
 * 一个会话里"栏内条目"的范围：renderDisplayItems 到 render 之间。
 * 显示控件（Select / 开关）只允许出现在这段里 —— 出现在别处就是又绕回了
 * 自由槽位或 ⋮ 面板，三端会重新长歪。
 */
const displayRegion = (src, where) => {
  const start = src.indexOf('renderDisplayItems = ()')
  assert.ok(start > -1, where + ' 必须有 renderDisplayItems')
  const end = src.indexOf('  render ()', start)
  assert.ok(end > start, where + ' 的 render () 在 renderDisplayItems 之后')
  return src.slice(start, end)
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
  test('连接信息由共享壳渲染，三端只交字段', () => {
    assert.match(SHELL, /import SessionInfo from '\.\/session-info'/)
    assert.match(SHELL, /<SessionInfo \{\.\.\.info\} \/>/)
    for (const [name, src] of Object.entries(sessions)) {
      assert.doesNotMatch(src, /import SessionInfo/, name + ' 不该再自己渲染 SessionInfo')
      assert.match(src, /info=\{\{/, name + ' 必须交 info')
      assert.doesNotMatch(src, /\{username\}@\{host\}:\{port\}/, name)
    }
  })

  test('SessionInfo 走纯函数，不自己拼格式', () => {
    const src = read('src/client/components/common/session-info.jsx')
    assert.match(src, /formatConnInfo/)
    assert.doesNotMatch(src, /username\}@/)
  })

  test('浮层菜单里的重复选屏入口已删除', () => {
    assert.doesNotMatch(FLOAT, /Select Screen|DesktopOutlined/)
    assert.doesNotMatch(FLOAT, /screens\.length/)
  })

  test('顶栏图标字号统一在共享壳里，RDP 不再自己写 font-size', () => {
    const shell = read('src/client/components/common/session-shell.styl')
    assert.match(shell, /\.remote-session-control-left\n\.remote-session-control-right/)
    assert.match(shell, /font-size 16px/)
    const rdpStyl = read('src/client/components/rdp/rdp.styl')
    assert.doesNotMatch(rdpStyl, /font-size/, '字号该由共享壳给，不该各端自己写')
  })
})

describe('VNC 会话内缩放（N2）', () => {
  test('缩放走三层优先级：本机记忆 > 书签(含 profile) > 默认开', () => {
    assert.match(vnc, /resolveScaleViewport\(/)
    assert.match(vnc, /`vnc-scale-view-\$\{host\}`/)
    assert.match(vnc, /ls\.getItemJSON\(scaleViewportLsKey\(props\.tab\?\.host\), null\)/)
    assert.match(vnc, /window\.store\.applyProfile\(deepCopy\(props\.tab \|\| \{\}\)\)\.scaleViewport/)
  })

  test('开关即时生效 + 首连也用决策值', () => {
    assert.match(vnc, /label=\{window\.translate\('scaleViewport'\)\}/)
    // setState 回调里重排，不重连；appliedFit 判等挡住重复写 setter
    assert.match(vnc, /setState\(\{\s*scaleViewport: v\s*\}, this\.updateViewLayout\)/)
    assert.match(vnc, /scaleViewport: this\.state\.scaleViewport/, 'vncOpts 不能再读 tab 字段')
    assert.match(vnc, /return !!this\.state\.scaleViewport/, 'getFit 由决策后的 state 驱动')
  })

  test('栏内开关的词条能取到（npm 语言包或补词通道，否则 UI 裸显 key）', () => {
    assert.ok(hasKey('scaleViewport'), 'scaleViewport')
    // 上一轮 R6 补的分辨率词条不能丢
    assert.ok(hasKey('resolutionAuto'), 'resolutionAuto')
  })
})

describe('顶栏条目契约（N3）· 共享壳', () => {
  test('自由槽位已删除：摆什么由壳定', () => {
    assert.doesNotMatch(SHELL, /controlLeft|controlRight|floatControl/, '壳不能再收自由槽位')
    assert.match(SHELL, /import RemoteFloatControl from '\.\/remote-float-control'/)
  })

  test('栏内顺序契约：左 = 重连｜显示项｜信息，右 = 全屏｜⋮', () => {
    const left = SHELL.slice(SHELL.indexOf('remote-session-control-left'), SHELL.indexOf('remote-session-control-right'))
    const order = [
      '<ReloadOutlined',
      '{displayItems}',
      '<SessionInfo'
    ].map(s => left.indexOf(s))
    assert.ok(order.every(i => i > -1), '左栏三件都要有：' + JSON.stringify(order))
    assert.deepEqual([...order].sort((a, b) => a - b), order, '左栏顺序：重连 → 显示项 → 信息')
    const right = SHELL.slice(SHELL.indexOf('remote-session-control-right'), SHELL.indexOf('remote-session-viewport'))
    assert.ok(right.indexOf('fullscreenIcon()') < right.indexOf('<RemoteFloatControl'), '右栏顺序：全屏 → ⋮')
  })

  test('⋮ 由壳统一渲染两份：栏内 + 全屏浮层', () => {
    const uses = SHELL.match(/<RemoteFloatControl/g) || []
    assert.equal(uses.length, 2, '栏内一份、全屏浮层一份')
    assert.match(SHELL, /fixedPosition=\{false\}/)
    for (const [, src] of Object.entries(sessions)) {
      assert.doesNotMatch(src, /<RemoteFloatControl/, '会话不该再自己摆 ⋮')
    }
  })

  test('显示控件留在栏内：Select / 开关只出现在 renderDisplayItems 里', () => {
    for (const [name, src] of Object.entries(sessions)) {
      const region = displayRegion(src, name)
      const outside = src.replace(region, '')
      assert.doesNotMatch(outside, /<Select|<SwitchLabel/, name + ' 的显示控件只能在栏内条目里')
      assert.match(region, /SwitchLabel/, name + ' 栏内必须有缩放开关')
      assert.match(src, /displayItems=\{this\.renderDisplayItems\(\)\}/, name + ' 必须把栏内条目交给壳')
      assert.doesNotMatch(src, /settings=\{/, name + ' 不能再把控件交给 ⋮ 设置区')
    }
  })

  test('控件压在 32px 行盒里：栏内每个 Select / 开关都走 small', () => {
    for (const [name, src] of Object.entries(sessions)) {
      const region = displayRegion(src, name)
      const controls = (region.match(/<Select|<SwitchLabel/g) || []).length
      const small = (region.match(/size='small'/g) || []).length
      assert.ok(controls > 0, name + ' 栏内没有显示控件')
      assert.equal(small, controls, name + ' 有控件没给 small 尺寸：' + controls + ' vs ' + small)
    }
  })

  test('三端缩放开关同口径：getFit 驱动 + 带文字的 SwitchLabel', () => {
    for (const [name, src] of Object.entries(sessions)) {
      const region = displayRegion(src, name)
      assert.match(region, /checked=\{this\.getFit\(\)\}/, name)
      assert.match(region, /label=\{window\.translate\('scaleViewport'\)\}/, name)
      assert.match(src, /SwitchLabel from '\.\.\/common\/switch'/, name + ' 缩放开关要走带标签的封装')
    }
  })

  test('⋮ 只是动作菜单：没有设置行、没有 popupRender 包层', () => {
    assert.match(FLOAT, /menu=\{\{ items \}\}/)
    assert.doesNotMatch(FLOAT, /popupRender/)
    assert.doesNotMatch(FLOAT, /settings\s*=\s*\[\]/)
    assert.doesNotMatch(FLOAT, /remote-float-setting/)
    // 全屏时栏整条隐藏（term-fullscreen.styl 收 .session-v-info），开关不需要
    // 再自证"不参与"，留着 disabled 只会让人以为全屏下还看得见它
    for (const [name, src] of Object.entries(sessions)) {
      assert.doesNotMatch(src, /disabled=\{!!this\.props\.fullscreen\}/, name)
    }
  })

  test('面板 CSS 不留无人使用的设置区', () => {
    const styl = read('src/client/components/common/remote-float-control.styl')
    assert.doesNotMatch(styl, /remote-float-panel|remote-float-setting/)
  })

  test('选屏只剩一个入口（栏内），且只在多屏时出现', () => {
    assert.doesNotMatch(vnc, /renderScreensSelect/, '栏内 Select 是唯一入口')
    assert.match(vnc, /screens\.length > 1/)
    assert.match(vnc, /<Select/)
  })

  test('栏内标签的词条能取到', () => {
    assert.ok(hasKey('scaleViewport'), 'scaleViewport')
    assert.ok(hasKey('resolutionAuto'), 'resolutionAuto')
  })
})
