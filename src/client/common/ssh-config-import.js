/**
 * 导入本地 ssh 配置的去重判据（纯函数，不碰 store）
 *
 * 为什么只认"ssh 配置来源"：手工建的书签是用户自己排过的（同主机不同用途、
 * 不同颜色都可能），自动合并等于替他删东西。而 ~/.ssh/config 导入这条路是
 * "点一次导入就新建一批 uid"，重复点几次，侧栏就叠出好几份一样的主机。
 *
 * 来源怎么认：新导入的书签带 sshConfigSource 标记；但标记之前历史数据没有，
 * 所以 sshConfig 分组里挂着的书签也算——不这么做，改动上线后第一次重新导入
 * 照样会再复制一份。
 */

/** 历史遗留：这个分组 id 从第一天起就是导入落点，不能改 */
export const sshConfigGroupId = 'sshConfig'

/** 书签上标来源的字段名与值 */
export const sourceField = 'importedFrom'

export const sshConfigSource = 'sshConfig'

/**
 * 一条 ssh 配置"是不是同一台机器的同一个入口"的键。
 * host 大小写不敏感（DNS 如此），user 同理；port 缺省按 22，
 * 因为 ssh 自己就是这么补的。
 */
export function sshConfigKey (item) {
  const host = String((item && item.host) || '').trim().toLowerCase()
  const user = String((item && item.username) || '').trim().toLowerCase()
  const port = String((item && item.port) || '').trim() || '22'
  return user + '@' + host + ':' + port
}

export function isSshConfigBookmark (bookmark) {
  return !!(bookmark && bookmark[sourceField] === sshConfigSource)
}

/**
 * 已经导入过的那些键。给了 groupIds 就把"挂在导入分组里"的书签也算进来，
 * 它们没有标记但确实是历史导入的产物。
 */
export function importedSshConfigKeys (bookmarks, group) {
  const inGroup = new Set(((group && group.bookmarkIds) || []).map(String))
  const keys = new Set()
  for (const b of bookmarks || []) {
    if (isSshConfigBookmark(b) || inGroup.has(String(b && b.id))) {
      keys.add(sshConfigKey(b))
    }
  }
  return keys
}

/** 列表自身先去重（同一次导入里也可能有重复块），再跳过已经导入过的 */
export function pickNewSshConfigItems (items, bookmarks, group) {
  const seen = importedSshConfigKeys(bookmarks, group)
  const fresh = []
  for (const item of items || []) {
    const key = sshConfigKey(item)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    fresh.push(item)
  }
  return fresh
}

/** 分组的书签列表：新导入的在前，重复 id 只留第一次出现 */
export function mergeBookmarkIds (ids, existingIds) {
  const out = []
  const seen = new Set()
  for (const id of [...(ids || []), ...(existingIds || [])]) {
    const k = String(id)
    if (seen.has(k)) {
      continue
    }
    seen.add(k)
    out.push(id)
  }
  return out
}
