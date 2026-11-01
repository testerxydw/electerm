// 图片附件处理层：把"用户贴进来的一张图"变成"能发给视觉模型的附件"。
//
// 为什么需要这一层，而不是把 File 直接交给请求体：视觉模型收的是 base64 分片，
// 原图直发会出三种事故。4000×3000 的手机截图按各家 token 口径能吃掉几千 token；
// HEIC/AVIF 这类 Chromium 解不动的格式解出来是空 dataUrl，用户以为发出去了而模型
// 什么都没看见；SVG 本质是 XML，既可能带脚本又不是视觉模型能吃的东西。
// 判定、缩放、编码退让和拒绝必须在这一层发生，不能留给调用方各写一遍。
//
// 纯计算 + 可注入 deps：渲染层与 node 单测共用这个文件，模块顶层不能碰 window /
// Document / FileReader，所有浏览器 API 只在函数体里经 deps 取，默认值才落到全局。
import uid from '../../common/uid.js'
import { fnv1a, formatSize } from './ai-attachments.js'

// 压缩前单文件上限：先卡原图体积再解码，解码成位图能占几十倍内存
export const MAX_IMAGE_INPUT_BYTES = 5 * 1024 * 1024

// 压缩后单张上限：这是"能不能发出去"的硬线，压不进去就报 tooLarge 而不是硬塞
export const MAX_IMAGE_BYTES = 1024 * 1024

// 单条消息最多几张：再多模型也不会看得更细，只会把上下文顶满
export const MAX_IMAGES_PER_MESSAGE = 4

// 本次草稿的图片总量：按压缩后的 bytes 计（见 validateImageBudget）
export const MAX_SESSION_IMAGE_BYTES = 8 * 1024 * 1024

// 长边上限，取各家视觉模型推荐输入尺寸的量级；再大只是白占 token
export const MAX_IMAGE_EDGE = 1568

// 附件卡片缩略图长边。缩略图要进历史，所以必须小
export const THUMB_EDGE = 96

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// 质量梯度：从接近无损开始逐级退让，先试的那档最可能保住观感
const IMAGE_QUALITY_LADDER = [0.9, 0.8, 0.7]

// 梯度用尽后再往下降质量的轮数（每轮整体乘 0.8）
const ENCODE_EXTRA_ROUNDS = 2

const IMAGE_EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

// type 可能带参数（image/png;charset=x），取分号前的主体
function mainType (file) {
  return String((file && file.type) || '').toLowerCase().split(';')[0].trim()
}

function extOf (file) {
  const m = /\.([a-z0-9]+)$/.exec(String((file && file.name) || '').toLowerCase())
  return m ? m[1] : ''
}

// 白名单内的 mime；type 为空时按扩展名兜底（部分 Linux 截图工具不给 type）。
// 返回 '' 表示不走图片通道。
function resolveImageMime (file) {
  if (!file) {
    return ''
  }
  const type = mainType(file)
  // SVG 明确排除：它是 XML，能带脚本，且各家视觉模型对 svg 的支持参差不齐，
  // 让它走图片通道等于把"能不能看"变成赌注
  if (type === 'image/svg+xml') {
    return ''
  }
  if (IMAGE_MIMES.includes(type)) {
    return type
  }
  if (type) {
    // type 有值但不在白名单（bmp/avif/tiff 或 text/*）时按类型拒，
    // 不给扩展名翻案的机会：改名成 .png 的 bmp 依旧解不动
    return ''
  }
  return IMAGE_EXT_TO_MIME[extOf(file)] || ''
}

// 采集阶段用的宽松版：image/* 但非 svg 都算候选。
// 白名单外的（bmp/avif）也先收下来，让 normalizeImageFile 给出明确的
// unsupportedType，而不是"贴了图但毫无反应"。
function looksLikeImage (file) {
  if (!file) {
    return false
  }
  if (resolveImageMime(file)) {
    return true
  }
  const type = mainType(file)
  return type.startsWith('image/') && type !== 'image/svg+xml'
}

export function isImageFile (file) {
  return !!resolveImageMime(file)
}

// base64 部分的长度反推字节数。不用 atob：atob 是浏览器全局，
// 而且把几百 KB 解码成字符串再量长度纯属浪费
function dataUrlBytes (dataUrl) {
  const s = String(dataUrl || '')
  const i = s.indexOf(',')
  const b64 = i >= 0 ? s.slice(i + 1) : s
  const n = b64.length
  if (!n) {
    return 0
  }
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0)
  return Math.max(0, Math.floor(n * 3 / 4) - pad)
}

// 长边超限才缩，且等比；小图绝不放大——放大不增加任何信息，
// 只会让体积和 token 估算一起变差
function fitEdge (width, height, edge) {
  const longest = Math.max(width, height)
  if (!longest || longest <= edge) {
    return { width, height }
  }
  const k = edge / longest
  // 至少留 1px：4000×1 这种极端长图按比例算下来短边会四舍五入成 0，
  // 0 高的画布画不出任何东西
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k))
  }
}

// 编码计划：按"先保观感、再保能发出去"的顺序排好所有尝试档位。
// png 先按 png 试一次（保得住透明就保），压不进 MAX_IMAGE_BYTES 才退 jpeg，
// 代价是透明像素变白底——"能发出去"比"保透明"重要，截图类内容本来就没有透明。
function buildEncodePlan (srcMime) {
  const lossy = srcMime === 'image/png' ? 'image/jpeg' : srcMime
  const plan = srcMime === 'image/png' ? [{ mime: 'image/png', quality: undefined }] : []
  for (const quality of IMAGE_QUALITY_LADDER) {
    plan.push({ mime: lossy, quality })
  }
  let q = IMAGE_QUALITY_LADDER[IMAGE_QUALITY_LADDER.length - 1]
  for (let i = 0; i < ENCODE_EXTRA_ROUNDS; i++) {
    // 额外轮只降质量、不再缩尺寸：尺寸已经落在 MAX_IMAGE_EDGE，
    // 继续缩会把截图里的文字压到看不清，而降质量对模型识别的影响小得多
    q = Math.round(q * 0.8 * 1000) / 1000
    plan.push({ mime: lossy, quality: q })
  }
  return plan
}

// 画到画布。opaque 为真时先铺白底：jpeg/webp 没有 alpha，Chromium 会把透明像素
// 压成黑底，白底更接近截图的观感，也和上面"透明会变白底"的取舍对得上
function paint (canvas, img, width, height, opaque) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return false
  }
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof ctx.drawImage !== 'function') {
    return false
  }
  ctx.clearRect(0, 0, width, height)
  if (opaque) {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(img, 0, 0, width, height)
  return true
}

function imageSize (img) {
  const w = Number(img.naturalWidth || img.width) || 0
  const h = Number(img.naturalHeight || img.height) || 0
  return { width: w, height: h }
}

export function extractPastedImages (clipboardData) {
  const out = []
  if (!clipboardData) {
    return out
  }
  const items = clipboardData.items
  if (items && typeof items.length === 'number') {
    for (const item of Array.from(items)) {
      try {
        if (!item || item.kind !== 'file') {
          continue
        }
        const file = item.getAsFile()
        if (looksLikeImage(file)) {
          out.push(file)
        }
      } catch (e) {
        // 单个条目取不出来不影响其余条目：某些 Linux 剪贴板实现在 getAsFile()
        // 上抛是常态，不是异常
      }
    }
  }
  const files = clipboardData.files
  if (files && typeof files.length === 'number') {
    for (const file of Array.from(files)) {
      // deepin 截图 / flameshot 这类工具会把同一张图同时放成"文件 URI"和"位图"，
      // 两个来源都收；去重放在调用方按内容指纹做，这里拿不到解码后的内容
      if (looksLikeImage(file)) {
        out.push(file)
      }
    }
  }
  return out
}

export async function normalizeImageFile (file, opts = {}) {
  const name = String((file && file.name) || 'image')
  let decoded = false
  try {
    const mime = resolveImageMime(file)
    if (!mime) {
      return { error: 'unsupportedType', name }
    }
    const originalBytes = Math.max(0, Number(file && file.size) || 0)
    if (originalBytes > MAX_IMAGE_INPUT_BYTES) {
      return { error: 'tooLarge', name }
    }
    const deps = resolveDeps(opts.deps)
    const raw = await deps.readAsDataURL(file)
    if (!raw) {
      return { error: 'decodeFailed', name }
    }
    const img = await deps.loadImage(raw)
    if (!img) {
      return { error: 'decodeFailed', name }
    }
    decoded = true
    const natural = imageSize(img)
    if (!natural.width || !natural.height) {
      // 解出了对象但尺寸为 0：等同于解不动（HEIC 在 Chromium 里的典型表现）
      return { error: 'decodeFailed', name }
    }
    const size = fitEdge(natural.width, natural.height, MAX_IMAGE_EDGE)
    // gif 取首帧并按 png 输出：视觉模型本来就按静态帧看，多帧发过去只是白占体积。
    // Chromium 把 gif 解码成 Image 时给的就是首帧，所以这里不需要额外抽帧。
    const isGif = mime === 'image/gif'
    const notice = isGif ? 'gifFirstFrame' : ''
    const canvas = deps.createCanvas(size.width, size.height)
    let encoded = null
    for (const step of buildEncodePlan(isGif ? 'image/png' : mime)) {
      if (!paint(canvas, img, size.width, size.height, step.mime !== 'image/png')) {
        return { error: 'encodeFailed', name }
      }
      // await 一个同步实现也成立，这样 deps 可以注入异步编码器
      const dataUrl = await deps.toDataURL(canvas, step.mime, step.quality)
      if (!dataUrl) {
        return { error: 'encodeFailed', name }
      }
      const bytes = dataUrlBytes(dataUrl)
      if (bytes <= MAX_IMAGE_BYTES) {
        encoded = { mime: step.mime, dataUrl, bytes }
        break
      }
    }
    if (!encoded) {
      // 梯度和额外两轮都压不进 MAX_IMAGE_BYTES：这张图大到发不出去。
      // 明确报 tooLarge，而不是硬塞一个超限分片把整个请求顶掉
      return { error: 'tooLarge', name }
    }
    // 缩略图：给附件卡片用，并且要跟着历史条目走，所以必须小
    const thumbSize = fitEdge(size.width, size.height, THUMB_EDGE)
    const thumbMime = (mime === 'image/png' || isGif) ? 'image/png' : 'image/jpeg'
    const thumbCanvas = deps.createCanvas(thumbSize.width, thumbSize.height)
    const thumbPainted = paint(thumbCanvas, img, thumbSize.width, thumbSize.height, thumbMime !== 'image/png')
    const thumbDataUrl = thumbPainted
      ? await deps.toDataURL(thumbCanvas, thumbMime, thumbMime === 'image/png' ? undefined : 0.7)
      : ''
    if (!thumbDataUrl) {
      // 缩略图失败不能拿主图兜底：主图是几百 KB 的 base64，会跟着历史条目反复重写
      return { error: 'encodeFailed', name }
    }
    const attachment = {
      id: opts.id || uid(),
      kind: 'image',
      name,
      mime: encoded.mime,
      width: size.width,
      height: size.height,
      bytes: encoded.bytes,
      originalBytes,
      thumbDataUrl,
      dataUrl: encoded.dataUrl,
      fingerprint: '',
      notice
    }
    attachment.fingerprint = imageFingerprint(attachment)
    return { attachment }
  } catch (e) {
    // 约定是"任何情况都不抛异常"：解码之前抛是读/解的问题，之后抛是画与编的问题
    return { error: decoded ? 'encodeFailed' : 'decodeFailed', name }
  }
}

// 去重身份。必须按内容（dataUrl）而不是 name + size：截图文件名几乎都是
// image.png，同分辨率连拍两张大小还相同，只比 name + size 会把第二张误丢
// （这个坑在文本附件那边已经踩过，见 ai-attachments.js 的同名注释）。
// 指纹只在加入时算一次并存在 attachment 上，后续判重是查表，不会反复哈希。
export function imageFingerprint (attachment) {
  const name = String((attachment && attachment.name) || '')
  const dataUrl = String((attachment && attachment.dataUrl) || '')
  return name + ':' + fnv1a(dataUrl)
}

export function isDuplicateImage (list, attachment) {
  const fp = attachment && attachment.fingerprint
  if (!fp) {
    return false
  }
  return (list || []).some(a => a && a.fingerprint === fp)
}

// 预算校验。按压缩后的 bytes 计，不能用原始体积：大图压缩后通常远低于原图，
// 用原始体积会把"5 MB 截图压成 300 KB"这种正常情况误拒。
export function validateImageBudget (list, extraBytes = 0, extraCount = 1) {
  const arr = Array.isArray(list) ? list : []
  if (arr.length + extraCount > MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, reason: 'count' }
  }
  const total = arr.reduce((s, a) => s + (Number(a && a.bytes) || 0), 0) +
    Math.max(0, Number(extraBytes) || 0)
  if (total > MAX_SESSION_IMAGE_BYTES) {
    return { ok: false, reason: 'bytes' }
  }
  return { ok: true, reason: '' }
}

// 图片已从内存缓存过期时，用这个文本替换真实分片。
// 不返回空串：空串等于"这条消息没带图"，模型会看见一个指代之物都不剩的"这张图"。
export function buildImagePlaceholder (attachment) {
  const name = String((attachment && attachment.name) || 'image')
  // 文件名可能带换行，占位符是拼进 prompt 的一行文本，换行会伪装成新的一行指令
  return '[attached image unavailable: ' + name.replace(/[\r\n]+/g, ' ') + ']'
}

// 体积提示：失败原因里要带"实际多大 / 上限多大"，单位口径复用文本附件那套
// （formatSize），免得两处一个写 KB 一个写 MB。文案本身归 i18n。
export function formatImageSizeHint (bytes, limit = MAX_IMAGE_INPUT_BYTES) {
  return formatSize(Math.max(0, Number(bytes) || 0)) + ' / ' + formatSize(Math.max(0, Number(limit) || 0))
}

// 默认实现只在被调用时才碰浏览器全局，模块顶层不引用 window / document
function defaultReadAsDataURL (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

function defaultLoadImage (dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode failed'))
    img.src = dataUrl
  })
}

function defaultCreateCanvas (width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function defaultToDataURL (canvas, mime, quality) {
  return canvas.toDataURL(mime, quality)
}

function resolveDeps (deps) {
  const d = deps || {}
  return {
    readAsDataURL: typeof d.readAsDataURL === 'function' ? d.readAsDataURL : defaultReadAsDataURL,
    loadImage: typeof d.loadImage === 'function' ? d.loadImage : defaultLoadImage,
    createCanvas: typeof d.createCanvas === 'function' ? d.createCanvas : defaultCreateCanvas,
    toDataURL: typeof d.toDataURL === 'function' ? d.toDataURL : defaultToDataURL
  }
}
