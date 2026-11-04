// 渲染层磁盘冷层包装（S2-2）：只验"什么该发给主进程、什么该跳过、失败要不要连累发送"。
// 主进程那侧的配额与回收在 ai-image-store.spec.js 里测。
const { describe, it, before, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

let m
let cache
const calls = []
let opResult = null
let opError = null

before(async () => {
  cache = await import('../../../src/client/components/ai/ai-image-cache.js')
  // 模块顶层不碰 window，函数体里才取，所以测试里挂一个假的即可
  globalThis.window = {
    pre: {
      runGlobalAsync: async (name, action, arg) => {
        calls.push({ name, action, arg })
        if (opError) {
          throw opError
        }
        return typeof opResult === 'function' ? opResult(action, arg) : opResult
      }
    }
  }
  m = await import('../../../src/client/components/ai/ai-image-persist.js')
})

beforeEach(() => {
  calls.length = 0
  opResult = null
  opError = null
  cache.clearImages()
  cache.setImageBudget(20 * 1024 * 1024)
})

describe('persistImage', () => {
  it('sends only id and dataUrl', async () => {
    opResult = { ok: true }
    await m.persistImage({
      id: 'i1',
      dataUrl: 'data:image/png;base64,AAAA',
      bytes: 3,
      name: 'x.png'
    })
    assert.deepEqual(calls, [{
      name: 'aiImageOp',
      action: 'put',
      arg: { id: 'i1', dataUrl: 'data:image/png;base64,AAAA' }
    }])
  })

  it('ignores records that are not a data url', async () => {
    await m.persistImage({ id: '', dataUrl: 'data:image/png;base64,AAAA' })
    await m.persistImage({ id: 'i1', dataUrl: 'raw-bytes' })
    await m.persistImage(null)
    assert.equal(calls.length, 0)
  })

  it('does not reject when the main process fails', async () => {
    opError = new Error('disk full')
    await m.persistImage({ id: 'i1', dataUrl: 'data:image/png;base64,AAAA' })
    assert.equal(calls.length, 1)
  })
})

describe('hydrateImages', () => {
  it('reads missing ids only, and memory hits skip the IPC', async () => {
    cache.putImage({ id: 'warm', dataUrl: 'data:image/png;base64,AAAA', bytes: 4 })
    opResult = (action, id) => (id === 'cold'
      ? { id: 'cold', dataUrl: 'data:image/png;base64,BBBB' }
      : null)
    const got = await m.hydrateImages(['warm', 'cold', 'nope', '', null])
    // warm 在内存里，不付 IPC；cold / nope 各问一次主进程
    assert.deepEqual(calls.map(c => c.arg), ['cold', 'nope'])
    // nope 那条主进程也没给回来
    assert.deepEqual(got, ['cold'])
    assert.ok(cache.resolveImage('cold'), '从磁盘回来的那张必须进了内存')
    assert.equal(cache.resolveImage('nope'), null)
  })

  it('keeps going when one entry cannot be read', async () => {
    opError = new Error('permission denied')
    const got = await m.hydrateImages(['a'])
    assert.deepEqual(got, [])
  })

  it('is a no-op without a main process', async () => {
    const saved = globalThis.window
    globalThis.window = {}
    assert.deepEqual(await m.hydrateImages(['a']), [])
    assert.deepEqual(await m.persistImage({ id: 'a', dataUrl: 'data:image/png;base64,AAAA' }), null)
    globalThis.window = saved
    assert.equal(calls.length, 0)
  })

  it('falls back to the byte estimate when the store sends no size', async () => {
    opResult = { id: 'i1', dataUrl: 'data:image/png;base64,AAAA' }
    await m.hydrateImages(['i1'])
    // 4 个 base64 字符 = 3 字节
    assert.equal(cache.imageCacheBytes(), 3)
  })
})

describe('forgetImage / clearPersistedImages', () => {
  it('routes the drop and clear actions', async () => {
    await m.forgetImage('i1')
    await m.clearPersistedImages()
    await m.forgetImage('')
    assert.deepEqual(calls.map(c => c.action), ['drop', 'clear'])
  })
})
