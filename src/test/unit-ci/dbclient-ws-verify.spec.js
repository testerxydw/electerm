const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SRC = f => path.join(ROOT, 'src/app/server', f)

// /dbclient ws 鉴权断环契约（2026-11-11）。
// 事故：dispatch-center 顶部 require db-client-ws（注册 /dbclient），
// db-client-ws 顶部反向 require dispatch-center 拿 verifyWs —— 循环依赖
// 环上拿到半成品 exports，verifyWs undefined，运行时 TypeError →
// ws.close()，主进程全部 DB 操作报
// "dbclient ws connection closed before replying"。
// 修复：verify 抽到 ws-verify.js 独立模块，双方向接引用它。
// 本契约锁源码事实：db-client-ws 禁止 require('./dispatch-center')，
// 双方都必须经 ws-verify 取 verify。

describe('dbclient-ws verify 断环契约', () => {
  const dbc = fs.readFileSync(SRC('db-client-ws.js'), 'utf8')
  const dc = fs.readFileSync(SRC('dispatch-center.js'), 'utf8')
  const wv = fs.readFileSync(SRC('ws-verify.js'), 'utf8')

  test('db-client-ws 不得 require dispatch-center（循环依赖环源头）', () => {
    assert.doesNotMatch(
      dbc,
      /require\(\s*['"]\.\/dispatch-center['"]\s*\)/,
      'db-client-ws.js 禁止 require dispatch-center（会拿到半成品 exports，verifyWs undefined）'
    )
  })

  test('db-client-ws 经 ws-verify 取 verifyWs', () => {
    assert.match(dbc, /const\s+verifyWs\s*=\s*require\('\.\/ws-verify'\)/)
  })

  test('dispatch-center 也经 ws-verify 取 verify（同一真源）', () => {
    assert.match(dc, /const\s+verify\s*=\s*require\('\.\/ws-verify'\)/)
    assert.ok(dc.includes('exports.verifyWs = verify'), '兼容导出保留')
  })

  test('ws-verify 自含鉴权逻辑（token 比对 + requireAuth 门）', () => {
    assert.match(wv, /to !== tokenElecterm/)
    assert.match(wv, /requireAuth === 'yes'/)
    assert.match(wv, /globalState\.authed/)
    // token 必须取自 process.env（server 子进程由 fork env 注入）
    assert.match(wv, /tokenElecterm\s*}\s*=\s*process\.env/)
  })
})
