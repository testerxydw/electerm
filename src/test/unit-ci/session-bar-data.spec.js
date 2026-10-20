/**
 * Test: session-bar-data — the single write point for top-bar session info.
 *
 * Pins:
 * 1. ssh-handshake-info messages are merged into store.sessionInfoMap[tabId]
 * 2. unknown / malformed actions return false (caller keeps passing through)
 * 3. clearSessionInfo removes the tab entry and tolerates missing keys
 */

process.env.NODE_ENV = 'development'

const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

let handleSessionControlMessage
let clearSessionInfo

// node sandbox has no window; session-bar-data reads window.store at call time
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}

// session-bar-data.js is ESM; load via dynamic import in the test runner
beforeEach(async () => {
  if (!handleSessionControlMessage) {
    const mod = await import('../../client/common/session-bar-data.js')
    handleSessionControlMessage = mod.handleSessionControlMessage
    clearSessionInfo = mod.clearSessionInfo
  }
  window.store = {
    sessionInfoMap: {}
  }
})

describe('session-bar-data handleSessionControlMessage', () => {
  test('ssh-handshake-info merges into sessionInfoMap by tabId', () => {
    const consumed = handleSessionControlMessage({
      action: 'ssh-handshake-info',
      tabId: 'tab-1',
      update: {
        kex: 'curve25519-sha256',
        serverHostKey: 'ssh-ed25519',
        cipherClientToServer: 'aes256-ctr',
        cipherServerToClient: 'aes256-ctr'
      }
    }, 'tab-1')
    assert.equal(consumed, true)
    assert.equal(window.store.sessionInfoMap['tab-1'].kex, 'curve25519-sha256')
    assert.equal(window.store.sessionInfoMap['tab-1'].cipherClientToServer, 'aes256-ctr')
  })

  test('second message for same tab merges without dropping earlier keys', () => {
    handleSessionControlMessage({
      action: 'ssh-handshake-info',
      tabId: 'tab-1',
      update: { kex: 'kex-a' }
    }, 'tab-1')
    handleSessionControlMessage({
      action: 'ssh-handshake-info',
      tabId: 'tab-1',
      update: { cipherClientToServer: 'aes256-ctr' }
    }, 'tab-1')
    const info = window.store.sessionInfoMap['tab-1']
    assert.equal(info.kex, 'kex-a')
    assert.equal(info.cipherClientToServer, 'aes256-ctr')
  })

  test('unknown action returns false so caller passes message through', () => {
    const consumed = handleSessionControlMessage({
      action: 'some-other-action',
      tabId: 'tab-1',
      update: { foo: 1 }
    }, 'tab-1')
    assert.equal(consumed, false)
    assert.deepEqual(window.store.sessionInfoMap, {})
  })

  test('malformed messages return false', () => {
    assert.equal(handleSessionControlMessage(null, 'tab-1'), false)
    assert.equal(handleSessionControlMessage({ action: 'ssh-handshake-info' }, ''), false)
    assert.equal(handleSessionControlMessage({ action: 'ssh-handshake-info', update: {} }, 'tab-1'), true)
  })

  test('missing store guards against early-boot calls', () => {
    delete window.store
    const consumed = handleSessionControlMessage({
      action: 'ssh-handshake-info',
      tabId: 'tab-1',
      update: { kex: 'x' }
    }, 'tab-1')
    assert.equal(consumed, false)
  })
})

describe('session-bar-data clearSessionInfo', () => {
  test('removes the tab entry', () => {
    window.store.sessionInfoMap['tab-2'] = { kex: 'kex-b' }
    clearSessionInfo('tab-2')
    assert.equal(window.store.sessionInfoMap['tab-2'], undefined)
  })

  test('tolerates unknown tabId / missing map', () => {
    clearSessionInfo('no-such-tab')
    delete window.store.sessionInfoMap
    clearSessionInfo('no-such-tab')
    assert.ok(true, 'no throw')
  })
})
