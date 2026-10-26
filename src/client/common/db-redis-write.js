/**
 * Redis 类型化写（T12，D 批）前端接口层。与 db-sql-favorite.js 同构的薄封装。
 *
 * 后端 10 个 op（全部 checkWritable 前置，readOnly 由主进程注入、渲染层传参不可信）：
 *   hashSetField / hashDelField / setAdd / setRem / zsetAdd / zsetRem /
 *   listPush / listSetAt / listRemAt / renameKeyNx
 *
 * 统一失败纪律（设计 §12.2）：
 * - 写失败必须刷新详情（refresh 回调重新拉服务端真实状态），绝不本地假更新成功状态
 * - 成功后同样刷新：hash/set 的 total、键列表计数都会变
 * - refresh 由调用方注入（selectRedisKey / loadRedisKeys 闭包），本模块不持有组件状态
 */

// IPC 通道：只经 dbClientOp 白名单分发
function runOp (tabId, op, args) {
  return window.pre.runGlobalAsync('dbClientOp', tabId, op, args)
}

// 'a' → ['a']；数组逐项 String 并滤空；其余 → []
function normalizeList (v) {
  if (typeof v === 'string') {
    return v ? [v] : []
  }
  if (Array.isArray(v)) {
    return v.map(x => String(x)).filter(x => x.length)
  }
  return []
}

// redis 只存字符串；undefined/null 存空串（与后端 toStr 同口径）
const toStr = v => (v === undefined || v === null ? '' : String(v))

// 参数组装（纯函数，导出仅供单测）：UI 输入 → dbClientOp args。
// 这里只做形状转换，不替后端校验语义（空 key / 非有限 score 由后端抛可读错误）
export function buildWriteArgs (op, p = {}) {
  const base = { dbIndex: Number(p.dbIndex) || 0, key: String(p.key || '') }
  switch (op) {
    case 'hashSetField':
      return { ...base, field: String(p.field || ''), value: toStr(p.value) }
    case 'hashDelField':
      return { ...base, fields: normalizeList(p.fields) }
    case 'setAdd':
    case 'setRem':
    case 'zsetRem':
      return { ...base, members: normalizeList(p.members) }
    case 'zsetAdd':
      return { ...base, score: Number(p.score), member: String(p.member || '') }
    case 'listPush':
      return { ...base, value: toStr(p.value), position: p.position }
    case 'listSetAt':
      return { ...base, index: Number(p.index), value: toStr(p.value) }
    case 'listRemAt':
      return {
        ...base,
        index: toStr(p.index),
        count: p.count === undefined ? 1 : Number(p.count)
      }
    case 'renameKeyNx':
      return { ...base, newKey: String(p.newKey || '') }
    default:
      throw new Error('unsupported redis write op: ' + op)
  }
}

/**
 * 统一执行一个类型化写 op。
 *
 * @param {string} tabId        数据库 tab id
 * @param {string} op           OP_MAP.redis 里的 op 名
 * @param {object} params       { dbIndex, key, ...op 各自参数 }
 * @param {object} hooks        { refresh, onSuccess } —— refresh 必传（除特殊流程）：
 *                              成功/失败两条路都会 await 它刷新详情
 * @returns {Promise<any>}      后端返回值（renameKeyNx 成功为 { ok: true }）
 * @throws                      后端错误原样上抛（含只读拦截 / RENAMENX 冲突可读信息）
 */
export async function redisWrite (tabId, op, params, hooks = {}) {
  const { refresh = null, onSuccess = null } = hooks
  const args = buildWriteArgs(op, params)
  try {
    const res = await runOp(tabId, op, args)
    if (refresh) {
      await refresh()
    }
    if (onSuccess) {
      onSuccess(res)
    }
    return res
  } catch (err) {
    // 失败必须刷新详情：拿服务端真实状态，绝不本地假更新
    if (refresh) {
      await refresh().catch(() => {})
    }
    throw err
  }
}
