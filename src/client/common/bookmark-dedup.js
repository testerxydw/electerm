/**
 * 书签查重的判据（纯函数，不碰 store）
 *
 * 口径：**同名 且 同连接** 才算重复（2026-11-02 与用户确认）。
 * - 只同名不算：`prod/web` 与 `dev/web` 是两个东西，侧栏就是靠名字分用途的。
 * - 只同连接不算：同一台跳板机两套密钥、同一个 host 两个用户都是常规排布，
 *   挡它等于挡正常工作 —— 与上一轮"ssh 配置导入只挡来源侧、不碰手工书签"同理。
 * - 两条同时成立时，第二条除了"又点了一次新建"没有别的解释。
 *
 * **判不了就不拦**：类型没有连接概念（本地终端）、标题为空、关键字段缺失，
 * 一律放行（连接键回空串）。误伤用户手工排好的书签，比放走一条重复贵得多。
 */

// 标题与主机都是用户写的，可打印分隔符不安全；这个字符敲不进输入框
const SEP = String.fromCharCode(0)

/**
 * 每种类型"连到哪儿"看哪些字段。没列进来的类型（local）不产连接键。
 * `key` 是那条连接的定位字段：它空着就等于"连到哪儿都说不清"，此时不产键（放行），
 * 而不是把所有空值都当成同一条 —— 用户名/端口空不代表两台机器是一台。
 * 字段一律小写比较：DNS 与 ssh 用户名在实际使用里都不区分大小写，
 * 抄写时的大小写不该被当成两条连接。
 */
const connFields = {
  ssh: { key: 'host', fields: ['host', 'port', 'username'] },
  telnet: { key: 'host', fields: ['host', 'port', 'username'] },
  ftp: { key: 'host', fields: ['host', 'port', 'username'] },
  rdp: { key: 'host', fields: ['host', 'port', 'username'] },
  vnc: { key: 'host', fields: ['host', 'port'] },
  spice: { key: 'host', fields: ['host', 'port'] },
  serial: { key: 'path', fields: ['path', 'baudRate'] },
  web: { key: 'url', fields: ['url'] }
}

/**
 * 端口缺省按协议补，理由与 ssh-config-import 里补 22 一样：
 * 一条写了 22、一条留空，指的就是同一个入口，不该判成两条。
 */
const defaultPort = {
  ssh: '22',
  telnet: '23',
  ftp: '21',
  rdp: '3389',
  vnc: '5900',
  spice: '5900'
}

/** 旧数据不带 type 时按 ssh 算（与 common/visibility.js、constants.js 同口径） */
const defaultType = 'ssh'

const databaseType = 'database'

const lower = v => String(v === undefined || v === null ? '' : v).trim().toLowerCase()

/**
 * 数据库书签单独一把键：`dbFile`（SQLite 那类本地文件）与 `dbHost` 是两套
 * 定位方式，混在通用字段里会把"两个不同文件"读成同一条连接。
 * 两边都没有 → 空串，判不了。
 */
function databaseConnKey (item) {
  const engine = lower(item.dbType)
  if (item.dbFile) {
    return ['db', engine, lower(item.dbFile)].join(SEP)
  }
  const host = lower(item.dbHost)
  if (!host) {
    return ''
  }
  return [
    'db', engine, host,
    String(item.dbPort === undefined || item.dbPort === null ? '' : item.dbPort).trim(),
    lower(item.dbUser), lower(item.dbName)
  ].join(SEP)
}

/** 连接键；空串表示"这条没有可比的对象"，调用方据此放行 */
export function bookmarkConnKey (item) {
  if (!item || typeof item !== 'object') {
    return ''
  }
  const type = lower(item.type) || defaultType
  if (type === databaseType) {
    return databaseConnKey(item)
  }
  const profile = connFields[type]
  if (!profile || !lower(item[profile.key])) {
    return ''
  }
  const parts = []
  for (const field of profile.fields) {
    let v = lower(item[field])
    // 端口按协议补：一条写了 22、一条留空，指的是同一个入口
    if (!v && field === 'port') {
      v = defaultPort[type] || ''
    }
    // ssh 的用户名空着就是 root（表单默认值 fix-bookmark-default.js，
    // 主进程 db-tunnel.js:89 也是 `username || 'root'` 这个口径）
    if (!v && field === 'username' && type === 'ssh') {
      v = 'root'
    }
    parts.push(field + '=' + v)
  }
  return type + SEP + parts.join(SEP)
}

/** 标题键；空标题不参与查重（用户还没起名，撞不上） */
export function bookmarkTitleKey (item) {
  if (!item || typeof item !== 'object') {
    return ''
  }
  return lower(item.title)
}

/** 两条书签是不是"同一件事又点了一次"：同名且同连接，两个条件都要成立 */
export function isSameBookmark (a, b) {
  const conn = bookmarkConnKey(a)
  const title = bookmarkTitleKey(a)
  if (!conn || !title) {
    return false
  }
  return conn === bookmarkConnKey(b) && title === bookmarkTitleKey(b)
}

/**
 * 已有书签里和它重复的那几条（排除自己，改名校验要用）。
 * @returns {Array} 命中的书签，按原列表顺序
 */
export function findDuplicateBookmarks (item, bookmarks, selfId) {
  if (!bookmarkConnKey(item) || !bookmarkTitleKey(item)) {
    return []
  }
  return (bookmarks || []).filter(b => {
    if (!b || String(b.id) === String(selfId)) {
      return false
    }
    return isSameBookmark(item, b)
  })
}

export function hasDuplicateBookmark (item, bookmarks, selfId) {
  return findDuplicateBookmarks(item, bookmarks, selfId).length > 0
}

/**
 * 给"仍然创建"这类确认文案用的一句话：把判据讲成人话，而不是把键印出来。
 */
export function describeBookmarkTarget (item) {
  if (!item || typeof item !== 'object') {
    return ''
  }
  const type = lower(item.type) || defaultType
  if (type === databaseType) {
    if (item.dbFile) {
      return lower(item.dbType) + '://' + String(item.dbFile).trim()
    }
    const host = String(item.dbHost || '').trim()
    const port = item.dbPort ? ':' + String(item.dbPort).trim() : ''
    const user = String(item.dbUser || '').trim()
    return (user ? user + '@' : '') + host + port
  }
  if (type === 'serial') {
    return String(item.path || '').trim()
  }
  if (type === 'web') {
    return String(item.url || '').trim()
  }
  const host = String(item.host || '').trim()
  const port = String(item.port || '').trim() || defaultPort[type] || ''
  const user = String(item.username || '').trim()
  return (user ? user + '@' : '') + host + (port ? ':' + port : '')
}

/**
 * 存量重复分组（"查看重复书签"清单用）：按 同名 + 同连接 聚堆，只留 2 条以上的。
 * 组内保持原列表顺序，界面上"最早那条"就是数组第一条，但删哪条由用户选 ——
 * 这里只负责列出来，不替用户决定保留谁。
 * @returns {Array<{key: string, title: string, target: string, items: Array}>}
 */
export function groupDuplicateBookmarks (bookmarks) {
  const buckets = new Map()
  for (const b of bookmarks || []) {
    const conn = bookmarkConnKey(b)
    const title = bookmarkTitleKey(b)
    if (!conn || !title) {
      continue
    }
    const key = title + SEP + conn
    const hit = buckets.get(key)
    if (hit) {
      hit.items.push(b)
    } else {
      buckets.set(key, { key, title: String(b.title).trim(), target: describeBookmarkTarget(b), items: [b] })
    }
  }
  const groups = []
  for (const g of buckets.values()) {
    if (g.items.length > 1) {
      groups.push(g)
    }
  }
  // 多的先给用户看：一次清理从最刺眼的那堆开始
  groups.sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title))
  return groups
}

/** 重复总数（清单入口的徽标用）：多出来的条数，不是组数 */
export function countDuplicateBookmarks (bookmarks) {
  let extra = 0
  for (const g of groupDuplicateBookmarks(bookmarks)) {
    extra += g.items.length - 1
  }
  return extra
}

/**
 * 批量导入（文件 / Navicat / ssh 配置之外的路子）用：默认跳过重复，把跳过的
 * 原样交回调用方去报数 —— 一条导入里逐条弹窗问"是否仍然创建"是没完的。
 */
export function pickNewBookmarks (items, bookmarks) {
  const fresh = []
  const skipped = []
  const seen = []
  for (const item of items || []) {
    const dup = findDuplicateBookmarks(item, bookmarks, item && item.id).length > 0 ||
      findDuplicateBookmarks(item, seen, item && item.id).length > 0
    if (dup) {
      skipped.push(item)
      continue
    }
    seen.push(item)
    fresh.push(item)
  }
  return { fresh, skipped }
}
