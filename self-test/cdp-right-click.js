#!/usr/bin/env node
/**
 * 通过 CDP 在 electerm 渲染进程指定坐标模拟右键（用于截图右键菜单）
 * 用法: node cdp-right-click.js <webSocketDebuggerUrl> [x] [y]
 */
const WebSocket = require('ws')

const url = process.argv[2]
const x = parseInt(process.argv[3] || '620', 10)
const y = parseInt(process.argv[4] || '300', 10)

const ws = new WebSocket(url)

ws.on('open', () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x, y, button: 'right', clickCount: 1 }
  }))
  ws.send(JSON.stringify({
    id: 2,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 }
  }))
  setTimeout(() => {
    console.log('right-click dispatched at', x, y)
    ws.close()
    process.exit(0)
  }, 800)
})

ws.on('error', (e) => {
  console.error('CDP_ERROR:', e.message)
  process.exit(1)
})

setTimeout(() => {
  console.error('CDP_TIMEOUT')
  process.exit(2)
}, 6000)
