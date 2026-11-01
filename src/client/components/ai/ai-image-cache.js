// 图片 dataUrl 的进程内缓存。
//
// 为什么图片本体不进 AI 历史库：历史条目在流式输出期间会被整条反复重写，几百 KB 的
// base64 跟着一起反复序列化，500 条上限下体积不可控，而且这些字节对磁盘上的检索
// 毫无价值。所以历史只存元数据 + 缩略图，图片本体放内存，重开窗口时按"已从内存
// 过期"处理（占位文本见 ai-image-attachments.js 的 buildImagePlaceholder）。
//
// 模块顶层不碰任何浏览器全局：这份文件同时被 node 单测 import，只依赖 Map。
// 也不 import ai-image-attachments.js——缓存只管字节，把体积常量搬过来只会让
// "查缓存"这条路径依赖上"处理图片"那条路径。
//
// 默认 20 MB：大约二十张顶格压缩后的图，够一整个工作会话用；上限的意义是
// "长时间不关窗也不会一直涨"
const DEFAULT_IMAGE_CACHE_BUDGET = 20 * 1024 * 1024

// Map 的插入序就是 LRU 顺序：touch 用 delete + 重新 set 把 key 挪到末尾，
// 于是第一个 key 永远是"最久未用"，不需要额外的时间戳字段
const cache = new Map()

// 记账单独存：bytes 是写入时算定的口径（漏传时按 dataUrl 估），逐出/删除时若回头
// 再读 record.bytes，那条估算就丢了，用量会只增不减
const sizes = new Map()
let budget = DEFAULT_IMAGE_CACHE_BUDGET
let used = 0

// 调用方漏传 bytes 时按 dataUrl 估，而不是当 0：计费口径一旦能被漏传绕过去，
// 预算就形同虚设
function estimateDataUrlBytes (dataUrl) {
  const s = String(dataUrl || '')
  const i = s.indexOf(',')
  const b64 = i >= 0 ? s.slice(i + 1) : s
  if (!b64.length) {
    return 0
  }
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0)
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad)
}

function recordBytes (record) {
  const n = Number(record.bytes)
  if (isFinite(n) && n >= 0) {
    return n
  }
  return estimateDataUrlBytes(record.dataUrl)
}

// 只给测试用：把预算调小才能在没有几百 KB 真图的情况下测逐出
export function setImageBudget (bytes) {
  const n = Number(bytes)
  budget = (isFinite(n) && n > 0) ? n : DEFAULT_IMAGE_CACHE_BUDGET
  return budget
}

export function getImageBudget () {
  return budget
}

export function putImage (record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'invalid-record' }
  }
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) {
    return { ok: false, reason: 'invalid-record' }
  }
  const bytes = recordBytes(record)
  // 单条就超预算的记录根本不写：写进去立刻会把别的挤光，而且下一次写入又会把它
  // 逐出，用户看到的是"刚贴就过期"。压缩后还超预算只可能是异常图，
  // 而 MAX_IMAGE_BYTES 那道闸门本该在归一化时就拒掉它
  if (bytes > budget) {
    return { ok: false, reason: 'over-budget' }
  }
  const prev = cache.get(id)
  if (prev) {
    // 同一 id 重写：旧体积要先从已用量里扣掉，否则用量会越算越虚高
    used -= (sizes.get(id) || 0)
    cache.delete(id)
  }
  cache.set(id, record)
  sizes.set(id, bytes)
  used += bytes
  const evicted = []
  // 刚写入这条不参与逐出：否则一张接近预算的图会把自己踢掉。
  // 快照 keys 再遍历，避免 delete 影响迭代
  for (const key of Array.from(cache.keys())) {
    if (used <= budget) {
      break
    }
    if (key === id) {
      continue
    }
    used -= (sizes.get(key) || 0)
    sizes.delete(key)
    cache.delete(key)
    evicted.push(key)
  }
  return { ok: true, evicted }
}

// 读取即"用过一次"：命中就把它挪到末尾，否则正在反复引用的图片会先被逐出
export function resolveImage (id) {
  if (typeof id !== 'string' || !id) {
    return null
  }
  const record = cache.get(id)
  if (!record) {
    return null
  }
  cache.delete(id)
  cache.set(id, record)
  return record
}

export function touchImage (id) {
  if (typeof id !== 'string' || !id) {
    return false
  }
  const record = cache.get(id)
  if (!record) {
    return false
  }
  cache.delete(id)
  cache.set(id, record)
  return true
}

export function dropImage (id) {
  if (typeof id !== 'string' || !cache.has(id)) {
    return false
  }
  used -= (sizes.get(id) || 0)
  sizes.delete(id)
  cache.delete(id)
  // 记账误差兜底：扣成负数说明某条 bytes 与写入时不一致，归零比留一个负数好查
  if (used < 0) {
    used = 0
  }
  return true
}

export function clearImages () {
  cache.clear()
  sizes.clear()
  used = 0
}

export function imageCacheBytes () {
  return used
}

// 当前 key，按最久未用 → 最近使用
export function cachedImageIds () {
  return Array.from(cache.keys())
}
