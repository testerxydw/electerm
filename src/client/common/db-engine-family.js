/**
 * 数据库引擎 / 方言名 → 语法家族（唯一权威）
 *
 * 为什么单独一份：同一个判断（"这条连接按 PG 的词法还是按 MySQL 的词法"）此前散在
 * 渲染层十几处裸比里 —— `dbType === 'postgres'`、`PG_NAMES.includes(d)`、
 * `dialect === 'pg'`……加一个 PG 兼容引擎（KingbaseES 这类）就得挨个改一遍，
 * **漏一处的后果不是"少个功能"，而是拿 MySQL 的词法去扫 PG 的语句**：双引号在 PG 是
 * 标识符、在 MySQL 是字符串字面量，反斜杠在 MySQL 是转义、在 PG 是普通字符 ——
 * 风险判定、掩码、过滤转义会当场判反，而且是"看起来正常"的那种错。
 *
 * 两种回落口径都保留（各自有调用方依赖，不能统一成一个）：
 * - `dbEngineFamily`：认不出的一律按 mysql 算 —— 与既有各处归一函数的口径一致，
 *   给"必须拿出一个方言"的调用方（引号、占位符、词法扫描）。
 * - `resolveDbEngineFamily`：认不出回 null —— 给"该不该给它 SQL 补全/高亮"的调用方
 *   （`getDialect`），未知引擎在这里不该被塞进 MySQL 方言里假装支持。
 * 新引擎必须在这里点名（`db-engine-family.spec.js` 拿 `constants.js` 的引擎清单对表，
 * 漏了直接红），所以回落永远不会悄悄吞掉一个新引擎。
 */

// 家族 id 与既有方言 id 同名（mysql / postgres / sqlite），redis 没有 SQL 语法
const mysql = 'mysql'
const postgres = 'postgres'
const sqlite = 'sqlite'
const redis = 'redis'

/**
 * 名字 → 家族。键一律小写。
 * 这里收的不只是书签里的引擎名：这条链上三种输入都出现过 —— `tab.dbType`（引擎）、
 * 主进程 `dialectOf` 的回执（适配器名）、导出/补全那几处的方言别名
 * （`postgresql` / `pg` / `sqlite3`），所以别名与引擎名共用一张表。
 */
const FAMILY_BY_NAME = {
  mysql,
  mariadb: mysql,
  tidb: mysql,
  oceanbase: mysql,
  postgres,
  postgresql: postgres,
  pg: postgres,
  pgsql: postgres,
  kingbase: postgres,
  sqlite,
  sqlite3: sqlite,
  redis
}

const norm = v => String(v === null || v === undefined ? '' : v).trim().toLowerCase()

const lookup = v => FAMILY_BY_NAME[norm(v)] || null

/** 家族 id；认不出按 mysql（与既有归一函数同口径） */
export function dbEngineFamily (name) {
  return lookup(name) || mysql
}

/** 家族 id；认不出回 null（调用方据此判定"这个引擎没有 SQL 语法可言"） */
export function resolveDbEngineFamily (name) {
  return lookup(name)
}

/**
 * 是不是 PG 家族。凡是"PG 与 MySQL 走不同写法"的分支都应该问这个函数，
 * 而不是自己比字符串 —— 否则新引擎一进来就落到 MySQL 那一支。
 */
export function isPgFamily (name) {
  return dbEngineFamily(name) === postgres
}

/** 是不是 SQLite（双引号标识符 + 没有反斜杠转义 + 没有 # 注释） */
export function isSqliteFamily (name) {
  return dbEngineFamily(name) === sqlite
}

/** 有 SQL 语法的引擎（redis 回 false） */
export function hasSqlDialect (name) {
  const family = resolveDbEngineFamily(name)
  return family === mysql || family === postgres || family === sqlite
}
