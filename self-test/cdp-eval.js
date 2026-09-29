#!/usr/bin/env node
/**
 * 通过 CDP（Chrome DevTools Protocol）在 electerm 渲染进程执行 JS
 * 用法: node cdp-eval.js '<webSocketDebuggerUrl>' '<expression>'
 */
const WebSocket = require('ws')

const url = process.argv[2]
const expression = process.argv[3] || 'window.dispatchEvent(new Event("open-command-palette"))'

const ws = new WebSocket(url)

ws.on('open', () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true }
  }))
})

ws.on('message', (d) => {
  console.log('CDP_RESULT:', d.toString().slice(0, 400))
  ws.close()
  process.exit(0)
})

ws.on('error', (e) => {
  console.error('CDP_ERROR:', e.message)
  process.exit(1)
})

setTimeout(() => {
  console.error('CDP_TIMEOUT')
  process.exit(2)
}, 6000)
