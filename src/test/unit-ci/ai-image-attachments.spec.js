// 图片输入这条链路上"会咬人"的两层：归一化（能不能发、发多大）与内存缓存（发过一次
// 之后还在不在）。两层的判断都不依赖 DOM，所以全部用注入的假 deps 钉死：
// - 类型闸门不能退化：svg 必须拒（它是 XML 不是位图），空 type 要能按扩展名兜住；
// - 解不动要报错，不能静默丢——静默丢的下一步是用户对着一个看不见图的模型重复发送；
// - 压缩退让是可验证的：假编码器按"像素数 × 质量"确定性地产出长度，梯度才能被钉住；
// - 缓存的 LRU 顺序、"刚写入不自逐"、单条超预算拒写，都是用户可见行为
//   （"刚贴就过期"是这套设计最不能出现的现象）。
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

let img
let cache

before(async () => {
  img = await import('../../../src/client/components/ai/ai-image-attachments.js')
  cache = await import('../../../src/client/components/ai/ai-image-cache.js')
})

const MAX_IMAGE_INPUT_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 4
const MAX_SESSION_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_EDGE = 1568
const THUMB_EDGE = 96

const fileOf = (o = {}) => ({
  name: 'shot.png',
  type: 'image/png',
  size: 2000,
  __dataUrl: 'data:image/png;base64,ORIGINAL',
  ...o
})

/**
 * 假 deps。
 *
 * 假 toDataURL 的输出长度是 (像素数 × 每像素字节数 × 质量) 的确定函数：
 * png 按 4 字节/像素、有损默认按 0.5 字节/像素（都是量级正确的近似），
 * 需要把退让梯度走深的用例可传 opts.lossyBpp 换掉那个近似系数。
 * 只有长度确定，"压不进上限就降一档质量再试"这条退让才可被测试观察，而不是碰巧。
 * 每次编码都往 state.encodes 追一条记录，主图各档 + 最后一次缩略图。
 *
 * 载荷里另外带上源图的指纹片段（定长，不影响字节数）：不然"同尺寸的两张图"在假
 * 编码器笔下是同一个字符串，按内容判重那条用例就没有可比的东西。
 */
function makeDeps (size = {}, opts = {}) {
  const state = { encodes: [], fills: 0, reads: 0 }
  const bpp = typeof opts.lossyBpp === 'number' ? opts.lossyBpp : 0.5
  const deps = {
    readAsDataURL: (file) => {
      state.reads++
      if (opts.readFails) {
        return Promise.reject(new Error('read failed'))
      }
      const url = file && file.__dataUrl
      return Promise.resolve(typeof url === 'string' ? url : 'data:image/png;base64,AAAA')
    },
    loadImage: (raw) => {
      if (opts.decodeFails) {
        return Promise.reject(new Error('decode failed'))
      }
      if (opts.zeroSize) {
        return Promise.resolve({ naturalWidth: 0, naturalHeight: 0 })
      }
      return Promise.resolve({
        naturalWidth: size.w || 0,
        naturalHeight: size.h || 0,
        __raw: String(raw || '')
      })
    },
    createCanvas: (w, h) => {
      const canvas = { width: w, height: h, __raw: '' }
      canvas.getContext = () => ({
        clearRect () {},
        // 铺白底是要验证的行为：有损编码要先铺白，否则透明像素会被压成黑底。
        // 主图画布是复用的，所以记累计次数而不是往画布上打标
        fillRect () { state.fills++ },
        drawImage (im) { canvas.__raw = (im && im.__raw) || '' }
      })
      return canvas
    },
    toDataURL: (canvas, mime, quality) => {
      state.encodes.push({
        width: canvas.width,
        height: canvas.height,
        mime,
        quality,
        fills: state.fills
      })
      if (opts.stuckEncoder) {
        // 编码器"怎么压都超限"的场景：真实世界里对应一张尺寸极大的图
        return 'data:' + mime + ';base64,' + 'A'.repeat(2 * 1024 * 1024)
      }
      const px = canvas.width * canvas.height
      const q = (quality === undefined || quality === null) ? 1 : quality
      const factor = mime === 'image/png' ? 4 : bpp
      const bytes = Math.max(1, Math.round(px * factor * q))
      const mark = String(canvas.__raw).split(',').pop().slice(0, 32).padEnd(32, 'A')
      const b64 = Math.max(32, Math.ceil(bytes * 4 / 3))
      return 'data:' + mime + ';base64,' + mark + 'A'.repeat(b64 - 32)
    }
  }
  return { deps, state }
}

// 主图各档 = 除最后一条之外的编码记录；最后一条恒为缩略图
const mainEncodes = state => state.encodes.slice(0, -1)
const thumbEncode = state => state.encodes[state.encodes.length - 1]

// 每次编码前是否重新铺了白底（累计值取差分）
const fillDeltas = state => state.encodes.map((e, i) => e.fills - (i ? state.encodes[i - 1].fills : 0))

describe('类型闸门', () => {
  it('常量与契约一致（改数值得是刻意的）', () => {
    assert.equal(img.MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUT_BYTES)
    assert.equal(img.MAX_IMAGE_BYTES, MAX_IMAGE_BYTES)
    assert.equal(img.MAX_IMAGES_PER_MESSAGE, MAX_IMAGES_PER_MESSAGE)
    assert.equal(img.MAX_SESSION_IMAGE_BYTES, MAX_SESSION_IMAGE_BYTES)
    assert.equal(img.MAX_IMAGE_EDGE, MAX_IMAGE_EDGE)
    assert.equal(img.THUMB_EDGE, THUMB_EDGE)
    assert.deepEqual(img.IMAGE_MIMES, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  })

  it('svg 既不是可发送图片，也不给进归一化', async () => {
    const f = fileOf({ name: 'icon.svg', type: 'image/svg+xml' })
    assert.equal(img.isImageFile(f), false)
    const r = await img.normalizeImageFile(f, { id: 'a', deps: makeDeps({ w: 100, h: 100 }).deps })
    assert.equal(r.error, 'unsupportedType')
    assert.equal(r.name, 'icon.svg')
  })

  it('type 为空时按扩展名兜底（Linux 截图工具常见）', () => {
    for (const name of ['x.png', 'x.jpg', 'x.jpeg', 'x.webp', 'x.gif', 'X.PNG']) {
      assert.equal(img.isImageFile({ name, type: '' }), true, name)
    }
    assert.equal(img.isImageFile({ name: 'notes.txt', type: '' }), false)
    assert.equal(img.isImageFile({ name: 'noext', type: '' }), false)
  })

  it('type 有值时以 type 为准：改名成 .png 的 octet-stream 不翻案', async () => {
    assert.equal(img.isImageFile({ name: 'x.png', type: 'application/octet-stream' }), false)
    const nonImage = fileOf({ name: 'a.txt', type: 'text/plain' })
    assert.equal(img.isImageFile(nonImage), false)
    const r = await img.normalizeImageFile(nonImage, { deps: makeDeps({ w: 10, h: 10 }).deps })
    assert.equal(r.error, 'unsupportedType')
  })

  it('白名单外的 image/* 给出 unsupportedType，而不是当成"不是图"悄悄丢掉', async () => {
    const r = await img.normalizeImageFile(fileOf({ name: 'a.avif', type: 'image/avif' }), {
      deps: makeDeps({ w: 10, h: 10 }).deps
    })
    assert.equal(r.error, 'unsupportedType')
  })

  it('空对象/null 入参不抛，返回错误码', async () => {
    for (const bad of [null, undefined, {}, { name: 1, type: 2 }]) {
      const r = await img.normalizeImageFile(bad, { deps: makeDeps({ w: 10, h: 10 }).deps })
      assert.ok(r.error, '必须有 error')
      assert.ok(typeof r.name === 'string')
    }
  })
})

describe('normalizeImageFile 的失败路径', () => {
  it('原始体积超限：在解码之前就拒，且不去读文件', async () => {
    const { deps, state } = makeDeps({ w: 3000, h: 3000 })
    const r = await img.normalizeImageFile(fileOf({ size: MAX_IMAGE_INPUT_BYTES + 1 }), { id: 'x', deps })
    assert.equal(r.error, 'tooLarge')
    assert.equal(state.reads, 0, '超原图上限不该走一次几百 MB 的解码')
  })

  it('解码失败 → decodeFailed（HEIC 在 Chromium 里就是这个下场，要明说）', async () => {
    const a = await img.normalizeImageFile(fileOf(), { deps: makeDeps({ w: 100, h: 100 }, { decodeFails: true }).deps })
    assert.equal(a.error, 'decodeFailed')
    const b = await img.normalizeImageFile(fileOf(), { deps: makeDeps({ w: 100, h: 100 }, { readFails: true }).deps })
    assert.equal(b.error, 'decodeFailed', '读不出来也归解码失败')
    const c = await img.normalizeImageFile(fileOf({ __dataUrl: '' }), { deps: makeDeps({ w: 100, h: 100 }).deps })
    assert.equal(c.error, 'decodeFailed', '空 dataUrl 等于没解出来')
    const d = await img.normalizeImageFile(fileOf(), { deps: makeDeps({}, { zeroSize: true }).deps })
    assert.equal(d.error, 'decodeFailed', '尺寸为 0 也是解不动')
  })

  it('画不出/编不出 → encodeFailed，不抛异常', async () => {
    const { deps, state } = makeDeps({ w: 100, h: 100 })
    let calls = 0
    deps.toDataURL = () => {
      // 覆盖掉假编码器：它不再有机会往 state.encodes 里记账，所以这里自己数
      calls++
      return ''
    }
    const r = await img.normalizeImageFile(fileOf(), { deps })
    assert.equal(r.error, 'encodeFailed')
    assert.equal(calls, 1, '编不出来就停，不该把整条梯度空跑一遍')
    assert.equal(state.encodes.length, 0)
    const noCtx = fileOf()
    const r2 = await img.normalizeImageFile(noCtx, {
      deps: { ...makeDeps({ w: 100, h: 100 }).deps, createCanvas: () => ({ width: 100, height: 100 }) }
    })
    assert.equal(r2.error, 'encodeFailed', '拿不到 2d context 要报错而不是崩')
  })

  it('不注入 deps 时也不抛（浏览器 API 只能在被调用时才碰）', async () => {
    const r = await img.normalizeImageFile(fileOf(), { id: 'no-deps' })
    assert.ok(!r.attachment)
    assert.ok(['unsupportedType', 'tooLarge', 'decodeFailed', 'encodeFailed'].includes(r.error))
  })
})

describe('缩放与压缩退让', () => {
  it('长边超过 MAX_IMAGE_EDGE 时等比缩到 1568', async () => {
    const { deps, state } = makeDeps({ w: 2000, h: 1000 })
    const r = await img.normalizeImageFile(fileOf(), { id: 'big', deps })
    const a = r.attachment
    assert.ok(a, JSON.stringify(r))
    assert.equal(a.width, 1568)
    assert.equal(a.height, 784, '宽高必须等比，否则图会被拉变形')
    assert.equal(mainEncodes(state)[0].width, 1568)
    assert.ok(Number.isInteger(a.bytes) && a.bytes > 0, 'bytes 要是真实字节数')
    assert.ok(a.bytes <= MAX_IMAGE_BYTES, '最终 bytes 必须在上限内')
    assert.equal(a.originalBytes, 2000)
    assert.equal(a.kind, 'image')
  })

  it('小图绝不放大', async () => {
    const { deps, state } = makeDeps({ w: 300, h: 200 })
    const r = await img.normalizeImageFile(fileOf(), { deps })
    assert.equal(r.attachment.width, 300)
    assert.equal(r.attachment.height, 200)
    assert.equal(mainEncodes(state).length, 1, '已经在预算内就别再折腾编码器')
  })

  it('字段齐全，notice 无内容时是空串', async () => {
    const { deps } = makeDeps({ w: 200, h: 150 })
    const a = (await img.normalizeImageFile(fileOf(), { id: 'keep-me', deps })).attachment
    for (const k of ['id', 'kind', 'name', 'mime', 'width', 'height', 'bytes', 'originalBytes',
      'thumbDataUrl', 'dataUrl', 'fingerprint', 'notice']) {
      assert.ok(k in a, '缺字段 ' + k)
    }
    assert.equal(a.id, 'keep-me', 'id 由调用方给，缓存键才认得它')
    assert.equal(a.notice, '')
    assert.equal(a.mime, 'image/png')
    assert.ok(a.thumbDataUrl.startsWith('data:image/'))
  })

  it('gif 取首帧并按 png 输出，notice 标注', async () => {
    const { deps, state } = makeDeps({ w: 200, h: 150 })
    const a = (await img.normalizeImageFile(fileOf({ name: 'anim.gif', type: 'image/gif' }), { deps })).attachment
    assert.equal(a.mime, 'image/png')
    assert.equal(a.notice, 'gifFirstFrame')
    assert.ok(a.dataUrl.startsWith('data:image/png'))
    assert.equal(mainEncodes(state)[0].mime, 'image/png')
    assert.equal(thumbEncode(state).mime, 'image/png', 'gif 的缩略图也走 png')
  })

  it('png 压不进 1MB 时退让到 jpeg，质量按梯度下降', async () => {
    const { deps, state } = makeDeps({ w: 1200, h: 900 })
    const a = (await img.normalizeImageFile(fileOf(), { deps })).attachment
    const tries = mainEncodes(state)
    assert.equal(tries[0].mime, 'image/png', '先按 png 试：保得住透明就保')
    assert.equal(tries[1].mime, 'image/jpeg')
    assert.equal(tries[1].quality, 0.9)
    assert.equal(a.mime, 'image/jpeg')
    assert.ok(a.bytes <= MAX_IMAGE_BYTES)
    assert.equal(tries.length, 2, '第一档就够就不该继续降')
  })

  it('梯度用尽后按 0.8 递减继续退让（1600×1200 要走到额外轮）', async () => {
    // lossyBpp 0.9：把"每像素一个字节"这个近似调重一点，让 1.8M 像素的图真的
    // 压不进前三档，梯度才有地方可走（默认 0.5 的话第一档有损就过了）
    const { deps, state } = makeDeps({ w: 1600, h: 1200 }, { lossyBpp: 0.9 })
    const a = (await img.normalizeImageFile(fileOf(), { deps })).attachment
    const qs = mainEncodes(state).map(e => e.quality)
    assert.deepEqual(qs, [undefined, 0.9, 0.8, 0.7, 0.56])
    assert.equal(a.mime, 'image/jpeg')
    assert.ok(a.bytes <= MAX_IMAGE_BYTES)
    assert.equal(a.width, 1568, '额外轮只降质量，尺寸仍停在长边上限')
    // 第一档是 png（没有质量参数），只比较有质量的档位
    const graded = qs.filter(q => typeof q === 'number')
    for (let i = 1; i < graded.length; i++) {
      assert.ok(graded[i] < graded[i - 1], '质量只能单调下降')
    }
  })

  it('有损编码先铺白底（透明变白底是"能发出去"的代价）', async () => {
    // lossyBpp 0.8 让这张 1.8M 像素的图走到梯度第三档才过，档位才够看清
    const { deps, state } = makeDeps({ w: 1600, h: 1200 }, { lossyBpp: 0.8 })
    await img.normalizeImageFile(fileOf(), { deps })
    // 档位顺序：png 不铺底（保透明）→ 有损各档各铺一次 → png 缩略图不铺
    assert.deepEqual(fillDeltas(state), [0, 1, 1, 1, 0])
    const j = makeDeps({ w: 1200, h: 900 })
    await img.normalizeImageFile(fileOf({ name: 'a.jpg', type: 'image/jpeg' }), { deps: j.deps })
    assert.deepEqual(fillDeltas(j.state), [1, 1], 'jpeg 源与 jpeg 缩略图都要铺底')
  })

  it('梯度与额外两轮都用尽 → tooLarge，不硬塞超限分片', async () => {
    const { deps, state } = makeDeps({ w: 2000, h: 1000 }, { stuckEncoder: true })
    const r = await img.normalizeImageFile(fileOf(), { deps })
    assert.equal(r.error, 'tooLarge')
    assert.equal(r.name, 'shot.png')
    const qs = state.encodes.map(e => e.quality)
    assert.deepEqual(qs, [undefined, 0.9, 0.8, 0.7, 0.56, 0.448], '3 档梯度 + 2 轮 ×0.8')
  })

  it('极端长宽比不出现 0 边长', async () => {
    const { deps, state } = makeDeps({ w: 4000, h: 50 })
    const a = (await img.normalizeImageFile(fileOf(), { deps })).attachment
    assert.ok(a.width >= 1 && a.height >= 1)
    assert.ok(thumbEncode(state).width >= 1 && thumbEncode(state).height >= 1)
  })
})

describe('缩略图', () => {
  it('长边 ≤ THUMB_EDGE', async () => {
    for (const size of [{ w: 2000, h: 1000 }, { w: 200, h: 150 }, { w: 4000, h: 50 }]) {
      const { deps, state } = makeDeps(size)
      const r = await img.normalizeImageFile(fileOf(), { deps })
      assert.ok(r.attachment, JSON.stringify(r))
      const t = thumbEncode(state)
      assert.ok(Math.max(t.width, t.height) <= THUMB_EDGE, JSON.stringify(t))
      assert.ok(r.attachment.thumbDataUrl.startsWith('data:image/'))
      assert.ok(r.attachment.thumbDataUrl.length < r.attachment.dataUrl.length, '缩略图要比主图小')
    }
  })

  it('jpeg 源用 jpeg(0.7)，png 源用 png', async () => {
    const j = makeDeps({ w: 200, h: 150 })
    await img.normalizeImageFile(fileOf({ name: 'a.jpg', type: 'image/jpeg' }), { deps: j.deps })
    assert.equal(thumbEncode(j.state).mime, 'image/jpeg')
    assert.equal(thumbEncode(j.state).quality, 0.7)
    assert.deepEqual(
      [thumbEncode(j.state).width, thumbEncode(j.state).height], [96, 72])
    const p = makeDeps({ w: 200, h: 150 })
    await img.normalizeImageFile(fileOf(), { deps: p.deps })
    assert.equal(thumbEncode(p.state).mime, 'image/png')
  })
})

describe('按内容去重', () => {
  it('同名同尺寸、内容不同的两张截图不能被判成重复', async () => {
    const a = (await img.normalizeImageFile(fileOf({ __dataUrl: 'data:image/png;base64,AAAA1' }),
      { id: 'a', deps: makeDeps({ w: 800, h: 600 }).deps })).attachment
    const b = (await img.normalizeImageFile(fileOf({ __dataUrl: 'data:image/png;base64,BBBB2' }),
      { id: 'b', deps: makeDeps({ w: 800, h: 600 }).deps })).attachment
    // 名字与原始体积完全一样——只看 name+size 的实现就是在这里丢第二张截图的
    assert.equal(a.name, b.name)
    assert.equal(a.originalBytes, b.originalBytes)
    assert.equal(a.width, b.width)
    assert.notEqual(a.fingerprint, b.fingerprint)
    assert.equal(img.isDuplicateImage([a], b), false)
  })

  it('内容相同的要判重（粘贴被同时当成位图与文件时靠这个收敛）', async () => {
    const mk = async (id) => (await img.normalizeImageFile(
      fileOf({ __dataUrl: 'data:image/png;base64,SAME' }), { id, deps: makeDeps({ w: 200, h: 150 }).deps })).attachment
    const a = await mk('a')
    const b = await mk('b')
    assert.notEqual(a.id, b.id, '两条附件各有 id')
    assert.equal(a.fingerprint, b.fingerprint)
    assert.equal(img.isDuplicateImage([a], b), true)
    assert.equal(img.isDuplicateImage([], a), false)
    assert.equal(img.isDuplicateImage(null, a), false)
    assert.equal(img.isDuplicateImage([a], null), false)
  })

  it('fingerprint 是 name + 内容哈希', () => {
    const fp = img.imageFingerprint({ name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' })
    assert.ok(fp.startsWith('shot.png:'))
    assert.equal(fp, img.imageFingerprint({ name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' }))
    assert.notEqual(fp, img.imageFingerprint({ name: 'shot.png', dataUrl: 'data:image/png;base64,AAB' }))
  })
})

describe('validateImageBudget', () => {
  const item = (bytes, originalBytes = 1024) => ({ kind: 'image', bytes, originalBytes })

  it('数量超限给 count', () => {
    const list = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, () => item(1000))
    assert.deepEqual(img.validateImageBudget(list), { ok: false, reason: 'count' })
    assert.equal(img.validateImageBudget(list.slice(0, -1)).ok, true, '刚好 4 张是可以的')
    assert.deepEqual(img.validateImageBudget(list, 0, 0), { ok: true, reason: '' })
  })

  it('字节超限给 bytes', () => {
    assert.deepEqual(img.validateImageBudget([], MAX_SESSION_IMAGE_BYTES + 1), { ok: false, reason: 'bytes' })
    const list = [item(3 * 1024 * 1024), item(3 * 1024 * 1024), item(3 * 1024 * 1024)]
    assert.deepEqual(img.validateImageBudget(list), { ok: false, reason: 'bytes' })
  })

  it('预算按压缩后的 bytes 计，不是原始体积', () => {
    // 5MB 的原图压到 200KB 是常态；按原始体积算会误拒
    const list = [item(200 * 1024, MAX_IMAGE_INPUT_BYTES), item(200 * 1024, MAX_IMAGE_INPUT_BYTES), item(200 * 1024, MAX_IMAGE_INPUT_BYTES)]
    assert.equal(img.validateImageBudget(list).ok, true)
    assert.ok(list.reduce((s, a) => s + a.originalBytes, 0) > MAX_SESSION_IMAGE_BYTES)
  })

  it('刚好等于上限算通过（判的是"超过"）', () => {
    assert.equal(img.validateImageBudget([item(MAX_SESSION_IMAGE_BYTES)]).ok, true)
    assert.equal(img.validateImageBudget([item(MAX_IMAGE_BYTES)]).ok, true)
  })

  it('脏数据（缺 bytes / 非数组）不当成超限', () => {
    assert.equal(img.validateImageBudget(undefined).ok, true)
    assert.equal(img.validateImageBudget([{}, { bytes: 'abc' }, null]).ok, true)
  })
})

describe('buildImagePlaceholder', () => {
  it('含名称且非空（不能退化成"这条消息没带图"）', () => {
    const s = img.buildImagePlaceholder({ name: 'shot.png' })
    assert.ok(s.length > 0)
    assert.match(s, /shot\.png/)
    assert.equal(s, '[attached image unavailable: shot.png]')
  })

  it('无附件对象也给得出东西，名称里的换行不会伪造新行', () => {
    assert.match(img.buildImagePlaceholder(), /image/)
    assert.ok(!/\n/.test(img.buildImagePlaceholder({ name: 'a\nb.txt' })))
  })
})

describe('extractPastedImages', () => {
  it('空入参 / 没有 items 都返回空数组，不抛', () => {
    for (const bad of [undefined, null, {}, { items: null }, { items: 'nonsense' }]) {
      assert.deepEqual(img.extractPastedImages(bad), [])
    }
  })

  it('items 与 files 两个来源都收（截图工具会同时给位图和文件 URI）', () => {
    const fromItems = fileOf({ __dataUrl: 'data:image/png;base64,SAME' })
    const fromFiles = fileOf({ __dataUrl: 'data:image/png;base64,SAME' })
    const cd = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => fromItems }],
      files: [fromFiles]
    }
    const out = img.extractPastedImages(cd)
    assert.equal(out.length, 2, '这里不去重，去重要等归一化后有内容指纹才能做')
    assert.equal(out[0], fromItems)
    assert.equal(out[1], fromFiles)
  })

  it('非文件的条目被忽略，取不出来的条目不影响其余', () => {
    const good = fileOf()
    const cd = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => { throw new Error('nope') } },
        { kind: 'file', type: 'text/plain', getAsFile: () => ({ name: 'a.txt', type: 'text/plain' }) },
        null,
        { kind: 'file', type: 'image/png', getAsFile: () => { throw new Error('clipboard died') } },
        { kind: 'file', type: 'image/png', getAsFile: () => good }
      ]
    }
    assert.deepEqual(img.extractPastedImages(cd), [good])
  })

  it('白名单外的 image/* 也先收（到归一化才有明确的 unsupportedType）', () => {
    const bmp = { name: 'a.bmp', type: 'image/bmp' }
    assert.deepEqual(img.extractPastedImages({ files: [bmp] }), [bmp])
    assert.deepEqual(img.extractPastedImages({ items: [{ kind: 'file', type: 'image/bmp', getAsFile: () => bmp }] }), [bmp])
    assert.deepEqual(img.extractPastedImages({ files: [{ name: 'a.svg', type: 'image/svg+xml' }] }), [])
    assert.deepEqual(img.extractPastedImages({ files: [{ name: 'a.txt', type: 'text/plain' }] }), [])
  })
})

describe('formatImageSizeHint', () => {
  it('单位口径跟文本附件一致', () => {
    assert.match(img.formatImageSizeHint(MAX_IMAGE_INPUT_BYTES), /5\.0 MB/)
    assert.match(img.formatImageSizeHint(2048, MAX_IMAGE_BYTES), /2\.0 KB \/ 1\.0 MB/)
  })
})

describe('图片内存缓存', () => {
  it('默认预算 20MB；setImageBudget 只认正数', () => {
    assert.equal(cache.getImageBudget(), 20 * 1024 * 1024)
    assert.equal(cache.setImageBudget(1000), 1000)
    assert.equal(cache.getImageBudget(), 1000)
    assert.equal(cache.setImageBudget(0), 20 * 1024 * 1024, '0 不是可用预算，回落默认')
    assert.equal(cache.setImageBudget('abc'), 20 * 1024 * 1024)
    cache.setImageBudget(1000)
  })

  it('写入即命中，字段原样存回来', () => {
    cache.clearImages()
    const rec = { id: 'i1', dataUrl: 'data:image/png;base64,AAA', bytes: 100, name: 'shot.png' }
    assert.deepEqual(cache.putImage(rec), { ok: true, evicted: [] })
    assert.equal(cache.imageCacheBytes(), 100)
    assert.equal(cache.resolveImage('i1'), rec, '要拿回同一个对象，附件字段不能散掉')
    assert.deepEqual(cache.cachedImageIds(), ['i1'])
  })

  it('缺 id 或非对象 → invalid-record，且不写不抛', () => {
    cache.clearImages()
    for (const bad of [null, undefined, 'str', 42, {}, [], { dataUrl: 'x', bytes: 1 }]) {
      assert.deepEqual(cache.putImage(bad), { ok: false, reason: 'invalid-record' })
    }
    assert.equal(cache.imageCacheBytes(), 0)
    assert.deepEqual(cache.cachedImageIds(), [])
  })

  it('单条本身超预算 → over-budget 且不写入', () => {
    cache.clearImages()
    cache.setImageBudget(1000)
    assert.deepEqual(cache.putImage({ id: 'big', dataUrl: 'x', bytes: 1001 }),
      { ok: false, reason: 'over-budget' })
    assert.deepEqual(cache.cachedImageIds(), [])
    assert.equal(cache.imageCacheBytes(), 0)
    assert.equal(cache.putImage({ id: 'eq', dataUrl: 'x', bytes: 1000 }).ok, true, '刚好等于预算要能进')
  })

  it('刚写入的接近预算的图不会把自己逐出（"刚贴就过期"）', () => {
    cache.clearImages()
    cache.setImageBudget(1000)
    cache.putImage({ id: 'a', dataUrl: 'A', bytes: 400 })
    const r = cache.putImage({ id: 'b', dataUrl: 'B', bytes: 900 })
    assert.equal(r.ok, true)
    assert.deepEqual(r.evicted, ['a'])
    assert.ok(cache.resolveImage('b'), '新写这条必须还在')
    assert.equal(cache.imageCacheBytes(), 900)
  })

  it('LRU：touch 与 resolve 都算用过一次，逐出最久未用的', () => {
    cache.clearImages()
    cache.setImageBudget(1000)
    cache.putImage({ id: 'a', dataUrl: 'A', bytes: 300 })
    cache.putImage({ id: 'b', dataUrl: 'B', bytes: 300 })
    cache.putImage({ id: 'c', dataUrl: 'C', bytes: 300 })
    assert.deepEqual(cache.cachedImageIds(), ['a', 'b', 'c'])
    assert.equal(cache.touchImage('a'), true)
    assert.deepEqual(cache.cachedImageIds(), ['b', 'c', 'a'])
    cache.resolveImage('b')
    assert.deepEqual(cache.cachedImageIds(), ['c', 'a', 'b'], '命中也算用过一次')
    const r = cache.putImage({ id: 'd', dataUrl: 'D', bytes: 300 })
    assert.deepEqual(r.evicted, ['c'], '逐出的应该是最久未用的那条')
    assert.deepEqual(cache.cachedImageIds(), ['a', 'b', 'd'])
    assert.equal(cache.imageCacheBytes(), 900)
  })

  it('超预算时连续逐出多条直到达标', () => {
    cache.clearImages()
    cache.setImageBudget(1000)
    cache.putImage({ id: 'a', dataUrl: 'A', bytes: 200 })
    cache.putImage({ id: 'b', dataUrl: 'B', bytes: 200 })
    cache.putImage({ id: 'c', dataUrl: 'C', bytes: 200 })
    const r = cache.putImage({ id: 'd', dataUrl: 'D', bytes: 700 })
    assert.deepEqual(r.evicted, ['a', 'b'])
    assert.deepEqual(cache.cachedImageIds(), ['c', 'd'])
    assert.equal(cache.imageCacheBytes(), 900)
  })

  it('同 id 重写只算一次体积', () => {
    cache.clearImages()
    cache.setImageBudget(1000)
    cache.putImage({ id: 'a', dataUrl: 'A', bytes: 600 })
    cache.putImage({ id: 'a', dataUrl: 'AA', bytes: 700 })
    assert.equal(cache.imageCacheBytes(), 700, '旧体积要先扣掉')
    assert.deepEqual(cache.cachedImageIds(), ['a'])
    assert.equal(cache.resolveImage('a').dataUrl, 'AA')
  })

  it('漏传 bytes 时按 dataUrl 估，不能当 0（否则预算形同虚设）', () => {
    cache.clearImages()
    cache.setImageBudget(20 * 1024 * 1024)
    cache.putImage({ id: 'a', dataUrl: 'data:image/png;base64,' + 'A'.repeat(400) })
    assert.equal(cache.imageCacheBytes(), 300)
    assert.equal(cache.dropImage('a'), true)
    assert.equal(cache.imageCacheBytes(), 0, '估算值也要能扣干净')
  })

  it('drop / clear 后字节归零', () => {
    cache.clearImages()
    cache.setImageBudget(1000)
    cache.putImage({ id: 'a', dataUrl: 'A', bytes: 300 })
    cache.putImage({ id: 'b', dataUrl: 'B', bytes: 300 })
    assert.equal(cache.dropImage('a'), true)
    assert.equal(cache.imageCacheBytes(), 300)
    assert.equal(cache.dropImage('a'), false, '重复删不再扣一次')
    assert.equal(cache.imageCacheBytes(), 300)
    cache.clearImages()
    assert.equal(cache.imageCacheBytes(), 0)
    assert.deepEqual(cache.cachedImageIds(), [])
  })

  it('缺失/非法 id 的读与 touch 返回 null/false，不抛', () => {
    cache.clearImages()
    assert.equal(cache.resolveImage('nope'), null)
    assert.equal(cache.resolveImage(undefined), null)
    assert.equal(cache.resolveImage(''), null)
    assert.equal(cache.touchImage('nope'), false)
    assert.equal(cache.dropImage('nope'), false)
    assert.deepEqual(cache.cachedImageIds(), [])
    assert.equal(cache.imageCacheBytes(), 0)
  })

  it('默认预算刚好装下 20 张顶格压缩的图，第 21 张只挤掉最旧的一张（量级检查）', () => {
    cache.clearImages()
    cache.setImageBudget(20 * 1024 * 1024)
    assert.equal(cache.getImageBudget(), 20 * 1024 * 1024)
    let evicted = 0
    for (let i = 0; i < 20; i++) {
      const r = cache.putImage({ id: 'i' + i, dataUrl: 'x', bytes: MAX_IMAGE_BYTES })
      if (!r.ok) {
        assert.fail('顶格单张不该被拒: ' + r.reason)
      }
      evicted += r.evicted.length
    }
    assert.equal(evicted, 0, '正好等于预算不该逐出')
    assert.equal(cache.imageCacheBytes(), 20 * 1024 * 1024)
    const r = cache.putImage({ id: 'last', dataUrl: 'x', bytes: MAX_IMAGE_BYTES })
    assert.deepEqual(r.evicted, ['i0'], '逐出的是最久未用的那条')
    assert.equal(cache.cachedImageIds().length, 20)
  })
})
