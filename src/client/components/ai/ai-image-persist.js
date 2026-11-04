// 图片本体的磁盘层（S2-2 / 设计 §6-11）：渲染层只负责把字节交出去、按 id 要回来，
// 配额、保留期、回收都在主进程（`src/app/lib/ai-image-store.js`）。
//
// 为什么要这一层：`ai-image-cache.js` 一重启就空，历史条目里只剩元数据，于是
// "上周那张截图"永远显示已过期、追问时只能带占位文本。写盘之后的语义是
// "内存是热层、磁盘是冷层"：内存命中就不碰 IPC，未命中才回主进程读一次。
//
// 模块顶层不碰 window：node 单测直接 import，所有全局只在函数体里取。
import { putImage, resolveImage } from './ai-image-cache.js'

// 主进程 IPC 通道。缺 window.pre 的环境（web 版、单测）一律当作"没有磁盘层"，
// 读写都退化成 no-op，绝不因为持久化失败挡住发消息。
function callOp (action, arg) {
  if (typeof window === 'undefined' ||
    !window.pre ||
    typeof window.pre.runGlobalAsync !== 'function') {
    return Promise.resolve(null)
  }
  return Promise.resolve()
    .then(() => window.pre.runGlobalAsync('aiImageOp', action, arg))
    .catch(() => null)
}

// 写入是"尽力而为"：主进程拒绝（超单张上限/配额）时这次只是没有冷层副本，
// 内存里的那张图照常能用，历史里它显示已过期而已，不影响这一轮发送。
export function persistImage (record) {
  if (!record || typeof record.id !== 'string' || !record.id) {
    return Promise.resolve(null)
  }
  const dataUrl = String(record.dataUrl || '')
  if (!dataUrl.startsWith('data:')) {
    return Promise.resolve(null)
  }
  return callOp('put', { id: record.id, dataUrl })
}

export function forgetImage (id) {
  if (typeof id !== 'string' || !id) {
    return Promise.resolve(null)
  }
  return callOp('drop', id)
}

export function clearPersistedImages () {
  return callOp('clear')
}

// 按 id 顺序补回内存。内存里已有的直接跳过（resolveImage 顺带把它挪到 LRU 末尾），
// 所以这个函数可以放心地反复调用：切换会话、刷新历史都只会为真正缺的那些付 IPC。
// 顺序是"最旧 → 最新"，内存预算不够时被逐出的是最早补回来的那批，最新留得住。
const inflight = new Set()

export async function hydrateImages (ids) {
  const list = Array.isArray(ids) ? ids : []
  const hydrated = []
  for (const id of list) {
    if (typeof id !== 'string' || !id) {
      continue
    }
    if (resolveImage(id) || inflight.has(id)) {
      continue
    }
    inflight.add(id)
    try {
      const rec = await callOp('get', id)
      // readImage 回的是 { id, dataUrl }，体积口径交给 putImage 自己按 dataUrl 估，
      // 与写入时一致；主进程那边配额/回收已经算过一次
      if (rec && typeof rec.dataUrl === 'string' &&
        putImage({ id, dataUrl: rec.dataUrl }).ok) {
        hydrated.push(id)
      }
    } finally {
      inflight.delete(id)
    }
  }
  return hydrated
}
