// 主进程图片磁盘层（S2-2 / 设计 §6-11）：配额、保留期、回收顺序都是纯决策，
// 单测直接喂假条目；落盘部分用 os.tmpdir() 下的真目录，不建在仓库里。
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const store = require('../../app/lib/ai-image-store')

let base

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-ai-image-store-'))
})

after(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function tmpDir (name) {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 小体积的一张图：内容不重要，字节数由 base64 长度决定
function dataUrl (payload) {
  return 'data:image/png;base64,' + Buffer.from(payload).toString('base64')
}

describe('safeId', () => {
  it('keeps filename-looking ids and rejects path shapes', () => {
    for (const ok of ['i1', 'abc.DEF_1', 'a-b_c.1', 'x'.repeat(100)]) {
      assert.equal(store.safeId(ok), ok)
    }
    for (const bad of ['', '..', '.hidden', '../x', 'a/b', 'a\\b', 'x'.repeat(101), undefined, null]) {
      assert.equal(store.safeId(bad), '', `should reject ${String(bad)}`)
    }
  })
})

describe('dataUrlBytes', () => {
  it('matches the decoded byte count, padding included', () => {
    assert.equal(store.dataUrlBytes('data:text/plain;base64,'), 0)
    assert.equal(store.dataUrlBytes(dataUrl('ab')), 2)
    assert.equal(store.dataUrlBytes(dataUrl('abc')), 3)
    // 不带逗号的串按整体 base64 处理
    assert.equal(store.dataUrlBytes(Buffer.from('abcd').toString('base64')), 4)
  })
})

describe('planEvictions', () => {
  it('drops entries past the retention window first', () => {
    const now = 1000
    const r = store.planEvictions([
      { id: 'old', bytes: 1, mtimeMs: 0 },
      { id: 'fresh', bytes: 1, mtimeMs: 900 }
    ], { now, maxAgeMs: 100, budget: 0, maxCount: 10 })
    assert.deepEqual(r.remove, ['old'])
    assert.deepEqual(r.keep.map(x => x.id), ['fresh'])
  })

  it('trims oldest entries until the count fits', () => {
    const r = store.planEvictions([
      { id: 'a', bytes: 1, mtimeMs: 1 },
      { id: 'b', bytes: 1, mtimeMs: 2 },
      { id: 'c', bytes: 1, mtimeMs: 3 }
    ], { maxAgeMs: 0, maxCount: 2, budget: 0 })
    assert.deepEqual(r.remove, ['a'])
    assert.deepEqual(r.keep.map(x => x.id), ['b', 'c'])
    assert.equal(r.bytes, 2)
  })

  it('trims oldest entries until the byte budget fits', () => {
    const r = store.planEvictions([
      { id: 'a', bytes: 500, mtimeMs: 1 },
      { id: 'b', bytes: 400, mtimeMs: 2 },
      { id: 'c', bytes: 300, mtimeMs: 3 }
    ], { maxAgeMs: 0, maxCount: 10, budget: 600 })
    // 最久未引用的 'a' 先走，剩 700 仍超，再走 'b'
    assert.deepEqual(r.remove, ['a', 'b'])
    assert.deepEqual(r.keep.map(x => x.id), ['c'])
    assert.equal(r.bytes, 300)
  })

  it('ignores malformed entries and sorts by mtime', () => {
    const r = store.planEvictions([
      { id: '', bytes: 10, mtimeMs: 1 },
      { id: 'b', bytes: -5, mtimeMs: 2 },
      { id: 'a', bytes: 7, mtimeMs: 0 },
      null
    ], { maxAgeMs: 0, maxCount: 10, budget: 0 })
    assert.deepEqual(r.remove, [])
    assert.deepEqual(r.keep.map(x => x.id), ['a', 'b'])
    // 负数按 0 记，不把总量算成负的
    assert.equal(r.bytes, 7)
  })
})

describe('disk roundtrip', () => {
  it('writes, lists and reads back the exact data url', () => {
    const dir = tmpDir('roundtrip')
    const a = dataUrl('alpha')
    const put = store.putImage(dir, { id: 'a1', dataUrl: a })
    assert.equal(put.ok, true)
    assert.equal(put.bytes, store.dataUrlBytes(a))
    assert.equal(store.readImage(dir, 'a1').dataUrl, a)

    // 读一次续期：mtime 必须往新里推，保留期才有意义
    const t0 = 1000
    fs.utimesSync(path.join(dir, 'a1.data'), new Date(t0), new Date(t0))
    store.readImage(dir, 'a1')
    const st = fs.statSync(path.join(dir, 'a1.data'))
    assert.ok(Number(st.mtimeMs) > t0)
  })

  it('lists by most recently used last and hides foreign files', () => {
    const dir = tmpDir('listing')
    store.putImage(dir, { id: 'a1', dataUrl: dataUrl('a') })
    store.putImage(dir, { id: 'b1', dataUrl: dataUrl('b') })
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    fs.writeFileSync(path.join(dir, '.hidden.data'), 'x')
    fs.utimesSync(path.join(dir, 'a1.data'), new Date(1), new Date(1))
    fs.utimesSync(path.join(dir, 'b1.data'), new Date(2), new Date(2))
    const list = store.listImages(dir).map(x => x.id)
    assert.deepEqual(list, ['a1', 'b1'])
    assert.deepEqual(store.listImages(tmpDir('missing')).length, 0)
  })

  it('rejects non-image payloads and illegal ids without throwing', () => {
    const dir = tmpDir('reject')
    assert.deepEqual(store.putImage(dir, { id: 'x', dataUrl: 'hello' }),
      { ok: false, reason: 'not-data-url' })
    assert.deepEqual(store.putImage(dir, { id: 'x', dataUrl: 'data:image/png;base64,' }),
      { ok: false, reason: 'empty' })
    assert.deepEqual(store.putImage(dir, { id: '../x', dataUrl: dataUrl('a') }),
      { ok: false, reason: 'invalid-id' })
    assert.equal(store.readImage(dir, '../x'), null)
    assert.equal(store.deleteImage(dir, '../x'), false)
  })

  it('sweeps to the given budget, oldest first, and reports what went', () => {
    const dir = tmpDir('sweep')
    for (const id of ['a1', 'b1', 'c1']) {
      store.putImage(dir, { id, dataUrl: dataUrl('payload-' + id) })
    }
    fs.utimesSync(path.join(dir, 'a1.data'), new Date(1), new Date(1))
    fs.utimesSync(path.join(dir, 'b1.data'), new Date(2), new Date(2))
    fs.utimesSync(path.join(dir, 'c1.data'), new Date(3), new Date(3))
    const r = store.sweep(dir, { maxAgeMs: 0, maxCount: 10, budget: 10 })
    assert.ok(r.removed.includes('a1'))
    assert.ok(r.count <= 2)
    assert.ok(r.bytes <= 10)
  })

  it('deletes and clears a directory', () => {
    const dir = tmpDir('clear')
    store.putImage(dir, { id: 'a1', dataUrl: dataUrl('a') })
    store.putImage(dir, { id: 'b1', dataUrl: dataUrl('b') })
    assert.equal(store.deleteImage(dir, 'a1'), true)
    assert.equal(store.readImage(dir, 'a1'), null)
    assert.deepEqual(store.clearImages(dir), { removed: 1 })
    assert.deepEqual(store.listImages(dir), [])
  })
})
