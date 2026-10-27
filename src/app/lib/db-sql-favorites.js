/**
 * SQL 查询收藏（B 批 B-1/B-2/B-4）主进程文件存储。
 * 与 db-sql-history 同策略：存 userData 固定 JSON 文件（userData/db-sql-favorites.json），
 * 不用渲染层 localStorage——UI server 动态端口导致 origin 漂移，跨启动互相隔离。
 * 仅存 id/标题/语句/引擎/更新时间——白名单过滤，密码/连接串等任何额外字段一律丢弃。
 * 上限 500 条；filePath 由调用方（ipc.js）传入，便于测试用临时目录隔离。
 * B-4 导入导出：JSON 文件往返（团队共享），重复 id 覆盖而非追加。
 */

const fs = require('fs')
const path = require('path')

const MAX = 500

function readFile (filePath) {
  try {
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]')
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    // 不存在/损坏/半截写：视作无收藏（辅助功能，不干扰主流程）
    return []
  }
}

function writeFile (filePath, list) {
  // 原子写：先写临时文件再 rename，避免写一半崩溃留半截 JSON
  const tmp = filePath + '.tmp'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(list))
  fs.renameSync(tmp, filePath)
}

// 白名单字段过滤：收藏是"标题 + 语句 + 分组"信息，多余字段（连接串/密码/任意大对象）
// 一律不落盘——这也是 B-4 团队共享 JSON 不含凭据的保障点。
// group：分组名，空串/缺省 = 默认分组（"我的收藏"），不做拆表存储、条目上挂名字段
function pickEntry (entry) {
  return {
    id: String(entry.id || ''),
    title: String(entry.title || '').slice(0, 200),
    sql: String(entry.sql || ''),
    dbType: entry.dbType || '',
    // group 只在入参里给且长度受限时才带，避免旧数据/脏数据被刷成 undefined
    group: entry.group && String(entry.group).slice(0, 80),
    ts: Number(entry.ts) || Date.now()
  }
}

// 归一化 SQL 作去重键：连续空白（含换行/缩进/制表）压成单空格，大小写归一。
// 与历史 db-sql-history.js 的 normSql 同思路——格式化只改空白布局，
// 归一化后同一语句等价，格式化前后不产生重复收藏；关键词大小写差异也归一。
function normSql (sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
}

// 稳定哈希：djb2 变体（32bit）。同一语句在不同保存/重启间哈希值一致，
// 可直接作"内容指纹"参与去重与展示，不存大段 SQL 的比较开销
function hashSql (sql) {
  const s = normSql(sql)
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

function listFavorites (filePath) {
  return readFile(filePath)
}

// 无 id 时生成：毫秒 ts + 随机后缀，同毫秒多次保存也不撞
function genId () {
  return 'fav-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

// 保存（upsert + 内容去重）：有 id 且已存在则整体覆盖（ts 刷新为更新时间）；
// 无 id 时按归一化 SQL 去重——命中的旧条目**合并**（刷新标题/分组/时间，不重复插入），
// 返回 { list, duplicate }：duplicate 为命中的旧条目（null 表示无重复）。
// 去重返回旧条目的 id 与 sql，供渲染层提示"已存在于默认分组/某分组"。
function saveFavorite (entry, filePath) {
  if (!entry || !entry.sql) {
    return { list: listFavorites(filePath), duplicate: null }
  }
  const list = readFile(filePath)
  const item = pickEntry(entry)
  const norm = normSql(item.sql)
  // 内容级去重：先按 id 找，再按归一化 SQL 找（新建场景 id 为空）
  let dup = null
  if (!item.id) {
    dup = list.find(x => x && normSql(x.sql) === norm) || null
  }
  if (dup) {
    // 合并进已有条目：保留原 id，刷新标题/分组/引擎/时间，置顶
    const merged = { ...dup, ...item, id: dup.id, ts: Date.now() }
    const idx = list.findIndex(x => x.id === dup.id)
    list.splice(idx, 1)
    list.unshift(merged)
    try {
      writeFile(filePath, list.slice(0, MAX))
    } catch (e) {
      // 磁盘满等：静默降级
    }
    return { list: list.slice(0, MAX), duplicate: dup }
  }
  if (!item.id) {
    item.id = genId()
  }
  item.ts = Number(entry.ts) || Date.now()
  const idx = list.findIndex(x => x.id === item.id)
  if (idx > -1) {
    list.splice(idx, 1)
  }
  list.unshift(item)
  try {
    writeFile(filePath, list.slice(0, MAX))
  } catch (e) {
    // 磁盘满等：静默降级，返回内存结果（下次启动可能丢这条，同历史的已知代价）
  }
  return { list: list.slice(0, MAX), duplicate: null }
}

function removeFavorite (id, filePath) {
  const list = readFile(filePath)
  const key = String(id || '')
  const idx = list.findIndex(x => x.id === key)
  if (idx > -1) {
    list.splice(idx, 1)
    try {
      writeFile(filePath, list)
    } catch (e) {
      // 静默降级
    }
  }
  return list
}

// B-4 导入：合法条目按 id upsert——重复 id 覆盖（整体替换，以导入文件为准），
// 新 id 追加到头部；非法条目（无 sql / 非对象）跳过。
// 返回 { list, imported, overwritten }，渲染层用于提示"导入 N 条（覆盖 M 条）"
function importFavorites (items, filePath) {
  const list = readFile(filePath)
  const arr = Array.isArray(items) ? items : []
  let imported = 0
  let overwritten = 0
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object' || !raw.sql) {
      continue
    }
    const item = pickEntry(raw)
    if (!item.id) {
      item.id = genId()
    }
    const idx = list.findIndex(x => x.id === item.id)
    if (idx > -1) {
      list.splice(idx, 1)
      overwritten++
    } else {
      imported++
    }
    list.unshift(item)
  }
  try {
    writeFile(filePath, list.slice(0, MAX))
  } catch (e) {
    // 静默降级
  }
  return { list: list.slice(0, MAX), imported, overwritten }
}

// B-4 导出：把渲染层给的收藏列表（通常就是当前 list）写成 JSON 文件。
// 过 pickEntry 白名单——即使用户手改过内存对象，落盘文件也绝不含凭据类字段。
// 返回写入条数
function exportFavorites (items, filePath) {
  const arr = Array.isArray(items) ? items : []
  const cleaned = arr
    .filter(x => x && typeof x === 'object' && x.sql)
    .map(x => pickEntry(x))
  const tmp = filePath + '.tmp'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2))
  fs.renameSync(tmp, filePath)
  return cleaned.length
}

// ---- 空分组登记（修复"新建分组后看不到"）----
// 分组原本只从收藏条目推导——空分组没有任何条目归属，永远不可见。
// 因此单独登记空分组名（userData/db-sql-fav-groups.json），与收藏数组分离，
// 不污染收藏 JSON 格式；一旦组内有条目则由推导天然覆盖，登记项冗余无害。
function readGroupsFile (groupsPath) {
  try {
    const arr = JSON.parse(fs.readFileSync(groupsPath, 'utf8') || '[]')
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x) : []
  } catch (e) {
    return []
  }
}

function writeGroupsFile (groupsPath, names) {
  const tmp = groupsPath + '.tmp'
  fs.mkdirSync(path.dirname(groupsPath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(names))
  fs.renameSync(tmp, groupsPath)
}

// 新建（登记）分组：幂等——重名直接返回现有列表
function createGroup (name, groupsPath) {
  const n = String(name || '').trim().slice(0, 80)
  const names = readGroupsFile(groupsPath)
  if (!n || names.includes(n)) {
    return names
  }
  names.push(n)
  try {
    writeGroupsFile(groupsPath, names)
  } catch (e) {
    // 静默降级：登记失败只影响"空分组可见性"，不影响收藏功能
  }
  return names
}

// 分组信息：从列表统计分组名 → 各分组条数（默认分组归并到 ''），
// 再合并"登记了但还没有条目"的空分组（计 0）。groupsPath 缺省时保持旧行为（纯推导）
function listGroups (filePath, groupsPath) {
  const list = readFile(filePath)
  const groups = {}
  for (const x of list) {
    if (!x) {
      continue
    }
    const g = x.group || ''
    groups[g] = (groups[g] || 0) + 1
  }
  if (groupsPath) {
    for (const g of readGroupsFile(groupsPath)) {
      if (!(g in groups)) {
        groups[g] = 0
      }
    }
  }
  return groups
}

// 重命名分组：把 list 里所有 group === old 的条目改写为 new，落盘；
// 空分组登记表同步改名。返回重命名后的完整列表。旧名不存在则原样返回。
function renameGroup (old, next, filePath, groupsPath) {
  if (!old || !next || old === next) {
    return readFile(filePath)
  }
  const list = readFile(filePath)
  let changed = false
  const nextList = list.map(x => {
    if (x && x.group === old) {
      changed = true
      return { ...x, group: next }
    }
    return x
  })
  if (changed) {
    try {
      writeFile(filePath, nextList)
    } catch (e) {
      // 静默降级
    }
  }
  if (groupsPath) {
    const names = readGroupsFile(groupsPath)
    if (names.includes(old)) {
      try {
        writeGroupsFile(groupsPath, names.map(n => (n === old ? next : n)))
      } catch (e) {
        // 静默降级
      }
    }
  }
  return changed ? nextList : list
}

// 删除分组：把 group === name 的条目**移回默认分组**（''）而非删除收藏——
// 删除条目是用户显式"删除收藏"的语义，删组不该连带把收藏一起丢。
// 空分组登记表同步移除该组。返回删除后的完整列表。
function deleteGroup (name, filePath, groupsPath) {
  if (!name) {
    return readFile(filePath)
  }
  const list = readFile(filePath)
  let changed = false
  const nextList = list.map(x => {
    if (x && x.group === name) {
      changed = true
      return { ...x, group: '' }
    }
    return x
  })
  if (changed) {
    try {
      writeFile(filePath, nextList)
    } catch (e) {
      // 静默降级
    }
  }
  if (groupsPath) {
    const names = readGroupsFile(groupsPath)
    if (names.includes(name)) {
      try {
        writeGroupsFile(groupsPath, names.filter(n => n !== name))
      } catch (e) {
        // 静默降级
      }
    }
  }
  return changed ? nextList : list
}

// 按分组筛选收藏条目：groups 为空数组/缺省 = 全部；否则只保留 group 命中列表里的条目。
// 供 B-4 导出"单个分组/多个分组/全选"三种粒度共用（纯筛选，不落盘）。
function filterByGroups (list, groups) {
  const arr = Array.isArray(list) ? list : []
  if (!Array.isArray(groups) || !groups.length) {
    return arr
  }
  const set = new Set(groups.map(g => g || ''))
  return arr.filter(x => x && set.has(x.group || ''))
}

// 读外部导入文件：解析失败/结构不对返回 null（渲染层提示文件无效）
function readImportFile (filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(data) ? data : null
  } catch (e) {
    return null
  }
}

module.exports = {
  MAX,
  listFavorites,
  saveFavorite,
  removeFavorite,
  importFavorites,
  exportFavorites,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  filterByGroups,
  normSql,
  hashSql,
  readImportFile
}
