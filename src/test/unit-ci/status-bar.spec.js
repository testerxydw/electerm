const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// format.js 无依赖，可直接加载
const load = async () => {
  return await import('../../client/components/status-bar/format.js')
}

describe('status-bar · format', () => {
  test('statusText：已知与未知状态', async () => {
    const { statusText } = await load()
    assert.equal(statusText('success'), '已连接')
    assert.equal(statusText('error'), '连接失败')
    assert.equal(statusText('connecting'), '连接中')
    assert.equal(statusText('whatever'), '未连接')
    assert.equal(statusText(undefined), '未连接')
  })

  test('typeText：会话类型判定', async () => {
    const { typeText } = await load()
    assert.equal(typeText({ authType: 'password' }), 'SSH')
    assert.equal(typeText({ type: 'sftp' }), 'SFTP')
    assert.equal(typeText({ type: 'serial' }), 'Serial')
    assert.equal(typeText({ type: 'telnet' }), 'Telnet')
    assert.equal(typeText({}), 'Local')
    assert.equal(typeText(null), '')
  })

  test('statusLine：类型与主机组合', async () => {
    const { statusLine } = await load()
    assert.equal(statusLine({ authType: 'x', host: '1.2.3.4' }), 'SSH · 1.2.3.4')
    assert.equal(statusLine({ type: 'sftp', title: 'files' }), 'SFTP · files')
    assert.equal(statusLine(null), '')
  })
})
