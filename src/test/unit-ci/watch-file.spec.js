// 批次 E：watch-file 异步读取 + 内容去重
// Electron 的 original-fs 在 Node 测试环境不可用，这里用 Module._load 注入替身，
// 执行真实源码（不复制实现）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const WATCH_FILE = path.join(__dirname, '../../app/lib/watch-file.js')

function createHarness () {
  const sent = []
  const watchers = new Map()
  const files = new Map()
  const reads = []
  let state = { watchFilePath: '', win: { webContents: { send: (ch, payload) => sent.push([ch, payload]) } } }

  const fakeFs = {
    existsSync: p => files.has(p),
    promises: {
      readFile: (p) => {
        const value = files.get(p)
        const read = { path: p, promise: null }
        const promise = Promise.resolve(value)
        read.promise = promise
        reads.push(read)
        return promise
      }
    },
    watchFile: (p, cb) => {
      watchers.set(p, cb)
    },
    unwatchFile: (p, cb) => {
      if (watchers.get(p) === cb) {
        watchers.delete(p)
      }
    }
  }

  const fakeState = {
    get: k => state[k],
    set: (k, v) => {
      state = { ...state, [k]: v }
    }
  }

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'original-fs') {
      return fakeFs
    }
    if (request === './glob-state' && parent && parent.filename === WATCH_FILE) {
      return fakeState
    }
    if (request === './lodash.js' && parent && parent.filename === WATCH_FILE) {
      // 跳过防抖，直接执行；真实防抖只改变调用时机
      return { debounce: fn => fn }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  delete require.cache[WATCH_FILE]
  const mod = require(WATCH_FILE)
  Module._load = originalLoad

  return {
    mod,
    sent,
    watchers,
    files,
    reads,
    getState: () => state,
    async trigger (file) {
      const cb = watchers.get(file)
      assert.ok(cb, 'watcher not registered for ' + file)
      await cb()
    }
  }
}

describe('批次 E：watch-file', () => {
  test('首次变更广播完整文本', async () => {
    const h = createHarness()
    h.files.set('/tmp/a.sql', 'select 1')
    h.mod.watchFile('/tmp/a.sql')
    await h.trigger('/tmp/a.sql')
    assert.deepEqual(h.sent, [['file-change', 'select 1']])
    assert.equal(h.reads.length, 1)
  })

  test('内容未变不重复广播', async () => {
    const h = createHarness()
    h.files.set('/tmp/a.sql', 'select 1')
    h.mod.watchFile('/tmp/a.sql')
    await h.trigger('/tmp/a.sql')
    await h.trigger('/tmp/a.sql')
    assert.equal(h.sent.length, 1, 'identical content must not be re-sent')
  })

  test('删除后广播 file-deleted，重建同内容会再广播', async () => {
    const h = createHarness()
    h.files.set('/tmp/a.sql', 'x')
    h.mod.watchFile('/tmp/a.sql')
    await h.trigger('/tmp/a.sql')
    h.files.delete('/tmp/a.sql')
    await h.trigger('/tmp/a.sql')
    h.files.set('/tmp/a.sql', 'x')
    await h.trigger('/tmp/a.sql')
    assert.deepEqual(h.sent.map(d => d[0]), ['file-change', 'file-deleted', 'file-change'])
  })

  test('读取期间切换被监听文件时丢弃旧内容', async () => {
    const h = createHarness()
    h.files.set('/tmp/a.sql', 'A')
    h.files.set('/tmp/b.sql', 'B')
    h.mod.watchFile('/tmp/a.sql')
    const pending = h.trigger('/tmp/a.sql')
    // 读尚未完成（Promise.resolve 也需微任务），先切到 b
    h.mod.watchFile('/tmp/b.sql')
    await pending
    assert.equal(h.sent.length, 0, 'stale read must not be broadcast')
    await h.trigger('/tmp/b.sql')
    assert.deepEqual(h.sent, [['file-change', 'B']])
  })

  test('异步读不阻塞主进程（源码不再使用 readFileSync）', () => {
    const src = require('node:fs').readFileSync(WATCH_FILE, 'utf8')
    assert.ok(src.includes('await fs.promises.readFile'), 'async read missing')
    assert.ok(!src.includes('fs.readFileSync('), 'sync read must be removed')
  })
})
