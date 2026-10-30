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
