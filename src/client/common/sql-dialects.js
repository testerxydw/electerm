/**
 * SQL 方言表（阶段4 A 批，设计 §4.7 纪律 1）
 *
 * 唯一真源：编辑器高亮、补全关键字、CREATE TABLE 类型建议、引号/注释规则
 * 全部从这里取，**不允许**在组件里另写一份关键字。新增引擎只加一条记录。
 *
 * 纯数据 + 纯函数：唯一的依赖是同目录的 db-engine-family.js（引擎 → 方言家族的
 * 定点表），node 单测可直接 import，不进浏览器 bundle 也成立。
 */

import { dbEngineFamily, resolveDbEngineFamily, hasSqlDialect } from './db-engine-family.js'

// MySQL 8.0 常用关键字（含 DDL/DML/TCL/权限；不含纯函数名——见 builtin）
const MYSQL_KEYWORDS = [
  'ADD', 'ALL', 'ALTER', 'ANALYZE', 'AND', 'AS', 'ASC', 'ASENSITIVE',
  'BEFORE', 'BETWEEN', 'BIGINT', 'BINARY', 'BLOB', 'BOTH', 'BY',
  'CALL', 'CASCADE', 'CASE', 'CHANGE', 'CHAR', 'CHARACTER', 'CHECK',
  'COLLATE', 'COLUMN', 'CONDITION', 'CONSTRAINT', 'CONTINUE', 'CONVERT',
  'CREATE', 'CROSS', 'CUBE', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'CURRENT_USER', 'CURSOR',
  'DATABASE', 'DATABASES', 'DAY_HOUR', 'DAY_MICROSECOND', 'DAY_MINUTE',
  'DAY_SECOND', 'DEC', 'DECIMAL', 'DECLARE', 'DEFAULT', 'DELAYED', 'DELETE',
  'DESC', 'DESCRIBE', 'DETERMINISTIC', 'DISTINCT', 'DISTINCTROW', 'DIV',
  'DOUBLE', 'DROP', 'DUAL',
  'EACH', 'ELSE', 'ELSEIF', 'ENCLOSED', 'ESCAPED', 'EXISTS', 'EXIT',
  'EXPLAIN', 'FALSE', 'FETCH', 'FLOAT', 'FLOAT4', 'FLOAT8', 'FOR', 'FORCE',
  'FOREIGN', 'FROM', 'FULLTEXT', 'FUNCTION',
  'GENERATED', 'GET', 'GRANT', 'GROUP', 'GROUPING', 'GROUPS',
  'HAVING', 'HIGH_PRIORITY', 'HOUR_MICROSECOND', 'HOUR_MINUTE', 'HOUR_SECOND',
  'IF', 'IGNORE', 'IN', 'INDEX', 'INFILE', 'INNER', 'INOUT', 'INSENSITIVE',
  'INSERT', 'INT', 'INT1', 'INT2', 'INT3', 'INT4', 'INT8', 'INTEGER',
  'INTERVAL', 'INTO', 'IS', 'ITERATE',
  'JOIN', 'JSON', 'KEY', 'KEYS', 'KILL',
  'LAG', 'LAST', 'LEAD', 'LEADING', 'LEAVE', 'LEFT', 'LIKE', 'LIMIT',
  'LINEAR', 'LINES', 'LOAD', 'LOCALTIME', 'LOCALTIMESTAMP', 'LOCK', 'LONG',
  'LONGBLOB', 'LONGTEXT', 'LOOP', 'LOW_PRIORITY',
  'MASTER_BIND', 'MATCH', 'MAXVALUE', 'MEDIUMBLOB', 'MEDIUMINT', 'MEDIUMTEXT',
  'MIDDLEINT', 'MINUTE_MICROSECOND', 'MINUTE_SECOND', 'MOD', 'MODIFIES',
  'NATURAL', 'NOT', 'NO_WRITE_TO_BINLOG', 'NULL', 'NUMERIC',
  'OF', 'ON', 'OPTIMIZE', 'OPTIMIZER_COSTS', 'OPTION', 'OPTIONALLY', 'OR',
  'ORDER', 'OUT', 'OUTER', 'OUTFILE', 'OVER', 'PARTITION', 'PARTITIONS',
  'PRECISION', 'PRIMARY', 'PROCEDURE', 'PURGE',
  'RANGE', 'READ', 'READS', 'READ_WRITE', 'REAL', 'RECURSIVE', 'REFERENCES',
  'REGEXP', 'RELEASE', 'RENAME', 'REPEAT', 'REPLACE', 'REQUIRE', 'RESIGNAL',
  'RESTRICT', 'RETURN', 'REVOKE', 'RIGHT', 'RLIKE', 'ROLLBACK', 'ROLLUP',
  'ROW', 'ROWS', 'ROW_NUMBER',
  'SCHEMA', 'SCHEMAS', 'SECOND_MICROSECOND', 'SELECT', 'SENSITIVE',
  'SEPARATOR', 'SET', 'SHOW', 'SIGNAL', 'SMALLINT', 'SPATIAL', 'SPECIFIC',
  'SQL', 'SQLEXCEPTION', 'SQLSTATE', 'SQLWARNING', 'SQL_BIG_RESULT',
  'SQL_CALC_FOUND_ROWS', 'SQL_SMALL_RESULT', 'SSL', 'STARTING', 'STORED',
  'STRAIGHT_JOIN',
  'TABLE', 'TERMINATED', 'TEXT', 'THEN', 'TINYBLOB', 'TINYINT', 'TINYTEXT',
  'TO', 'TRAILING', 'TRANSACTION', 'TRIGGER', 'TRUE', 'TRUNCATE',
  'UNDO', 'UNION', 'UNIQUE', 'UNLOCK', 'UNSIGNED', 'UPDATE', 'USAGE', 'USE',
  'USING', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP',
  'VALUES', 'VARBINARY', 'VARCHAR', 'VARCHARACTER', 'VARYING', 'VIEW',
  'VIRTUAL', 'WHEN', 'WHERE', 'WHILE', 'WINDOW', 'WITH', 'WRITE',
  'XOR', 'YEAR_MONTH', 'ZEROFILL'
]

// MySQL 内置函数（补全 builtin 类；不含自定义函数）
const MYSQL_BUILTIN = [
  'ABS', 'AVG', 'CAST', 'CEIL', 'CEILING', 'CHAR_LENGTH', 'COALESCE',
  'CONCAT', 'CONCAT_WS', 'COUNT', 'CURDATE', 'CURTIME', 'DATE', 'DATE_ADD',
  'DATE_FORMAT', 'DATE_SUB', 'DATEDIFF', 'ELT', 'EXTRACT', 'FIELD',
  'FIND_IN_SET', 'FLOOR', 'FORMAT', 'FROM_UNIXTIME', 'GREATEST', 'GROUP_CONCAT',
  'IF', 'IFNULL', 'INSTR', 'JSON_ARRAY', 'JSON_EXTRACT', 'JSON_OBJECT',
  'JSON_UNQUOTE', 'LEAST', 'LEFT', 'LENGTH', 'LOCATE', 'LOWER', 'LPAD',
  'LTRIM', 'MAX', 'MD5', 'MIN', 'NOW', 'NULLIF', 'RAND', 'REGEXP_REPLACE',
  'REPLACE', 'REVERSE', 'RIGHT', 'ROUND', 'ROW_COUNT', 'RPAD', 'RTRIM',
  'SHA1', 'SHA2', 'SIGN', 'SLEEP', 'SUBSTR', 'SUBSTRING', 'SUBSTRING_INDEX',
  'SUM', 'TIMESTAMPDIFF', 'TRIM', 'TRUNCATE', 'UNIX_TIMESTAMP', 'UPPER',
  'UUID', 'WEEK', 'YEAR'
]

// MySQL 数据类型（CREATE TABLE / ADD COLUMN 建议）
const MYSQL_TYPES = [
  'BIGINT', 'BINARY', 'BIT', 'BLOB', 'CHAR', 'DATE', 'DATETIME', 'DECIMAL',
  'DOUBLE', 'ENUM', 'FLOAT', 'GEOMETRY', 'INT', 'INTEGER', 'JSON',
  'LONGBLOB', 'LONGTEXT', 'MEDIUMBLOB', 'MEDIUMINT', 'MEDIUMTEXT', 'SET',
  'SMALLINT', 'TEXT', 'TIME', 'TIMESTAMP', 'TINYBLOB', 'TINYINT', 'TINYTEXT',
  'VARBINARY', 'VARCHAR', 'YEAR'
]

// PostgreSQL 关键字（含 PG 特有 RETURNING/LATERAL/ILIKE/MATERIALIZED 等）
const PG_KEYWORDS = [
  'ALL', 'ALTER', 'ANALYZE', 'AND', 'ANY', 'ARRAY', 'AS', 'ASC', 'ASYMMETRIC',
  'AT', 'AUTHORIZATION',
  'BETWEEN', 'BIGINT', 'BINARY', 'BIT', 'BOOLEAN', 'BOTH', 'BY',
  'CASE', 'CAST', 'CHAR', 'CHARACTER', 'CHECK', 'COALESCE', 'COLLATE',
  'COLUMN', 'CONCURRENTLY', 'CONFLICT', 'CONSTRAINT', 'CREATE', 'CROSS',
  'CUBE', 'CURRENT_DATE', 'CURRENT_ROLE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
  'CURRENT_USER',
  'DECIMAL', 'DEFAULT', 'DEFERRABLE', 'DELETE', 'DESC', 'DISTINCT', 'DO',
  'DROP', 'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXCLUDE', 'EXISTS', 'EXPLAIN',
  'EXTENSION', 'EXTRACT',
  'FALSE', 'FETCH', 'FILTER', 'FIRST', 'FLOAT', 'FOLLOWING', 'FOR', 'FOREIGN',
  'FROM', 'FULL', 'FUNCTION',
  'GENERATED', 'GRANT', 'GREATEST', 'GROUP', 'GROUPING', 'GROUPS',
  'HAVING', 'ILIKE', 'IN', 'INDEX', 'INNER', 'INSERT', 'INT', 'INTEGER',
  'INTERSECT', 'INTERVAL', 'INTO', 'IS', 'ISNULL',
  'JOIN', 'JSON', 'JSONB', 'KEY', 'LATERAL', 'LEADING', 'LEAST', 'LEFT',
  'LIKE', 'LIMIT', 'LOCALTIME', 'LOCALTIMESTAMP', 'LOCK',
  'MATERIALIZED', 'NATURAL', 'NOT', 'NOTNULL', 'NOWAIT', 'NULL', 'NULLIF',
  'NULLS', 'NUMERIC',
  'OFFSET', 'ON', 'ONLY', 'OR', 'ORDER', 'OTHERS', 'OUTER', 'OVER',
  'OVERLAPS', 'PARTITION', 'PLACING', 'PRECEDING', 'PRIMARY', 'RANGE',
  'REAL', 'RECURSIVE', 'REFERENCES', 'REFRESH', 'RETURNING', 'REVOKE',
  'RIGHT', 'ROLLBACK', 'ROLLUP', 'ROW', 'ROWS',
  'SCHEMA', 'SELECT', 'SEQUENCE', 'SERIAL', 'SESSION_USER', 'SET', 'SETS',
  'SIMILAR', 'SMALLINT', 'SOME', 'SYMMETRIC',
  'TABLE', 'TABLESAMPLE', 'TEXT', 'THEN', 'TIES', 'TIME', 'TIMESTAMP', 'TO',
  'TRAILING', 'TRANSACTION', 'TRIGGER', 'TRUE', 'TRUNCATE', 'TYPE',
  'UNBOUNDED', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'USING',
  'VACUUM', 'VALUES', 'VARCHAR', 'VERBOSE', 'VIEW',
  'WHEN', 'WHERE', 'WINDOW', 'WITH', 'XMLATTRIBUTES'
]

const PG_BUILTIN = [
  'ABS', 'AGE', 'ARRAY_AGG', 'AVG', 'BOOL_AND', 'BOOL_OR', 'BTRIM', 'CARDINALITY',
  'CEIL', 'CEILING', 'CHAR_LENGTH', 'CONCAT', 'CONCAT_WS', 'COUNT',
  'CURRENT_SETTING', 'DATE_PART', 'DATE_TRUNC', 'DECODE', 'ENCODE', 'EXTRACT',
  'FLOOR', 'FORMAT', 'GENERATE_SERIES', 'GREATEST', 'JSON_AGG',
  'JSONB_AGG', 'JSONB_BUILD_OBJECT', 'JSONB_EACH', 'JSONB_EACH_TEXT',
  'LAG', 'LEAD', 'LEAST', 'LEFT', 'LENGTH', 'LOWER', 'LPAD', 'LTRIM', 'MAX',
  'MD5', 'MIN', 'NOW', 'NULLIF', 'PERCENTILE_CONT', 'POSITION', 'RANDOM',
  'REGEXP_REPLACE', 'REPLACE', 'REVERSE', 'RIGHT', 'ROUND', 'ROW_NUMBER',
  'RPAD', 'RTRIM', 'SPLIT_PART', 'STDDEV', 'STRING_AGG', 'SUBSTR', 'SUBSTRING',
  'SUM', 'TO_CHAR', 'TO_DATE', 'TO_JSON', 'TO_JSONB', 'TO_NUMBER',
  'TO_TIMESTAMP', 'TRANSLATE', 'TRIM', 'UNNEST', 'UPPER', 'VERSION'
]

const PG_TYPES = [
  'BIGINT', 'BIGSERIAL', 'BIT', 'BOOLEAN', 'BOX', 'BYTEA', 'CHAR', 'CIDR',
  'CIRCLE', 'DATE', 'DECIMAL', 'DOUBLE PRECISION', 'INET', 'INT', 'INTEGER',
  'INTERVAL', 'JSON', 'JSONB', 'LINE', 'LSEG', 'MACADDR', 'MONEY', 'NUMERIC',
  'PATH', 'POINT', 'POLYGON', 'REAL', 'SERIAL', 'SMALLINT', 'SMALLSERIAL',
  'TEXT', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'TSQUERY', 'TSVECTOR', 'UUID',
  'VARBIT', 'VARCHAR', 'XML'
]

// SQLite 关键字（3.4x 保留字表里会真出现在 SQL 文本里的那些；
// 不收 ABC/DEF/GLOB 等"文档列了但基本用不上"的冷词，补全候选淹掉常用项）
const SQLITE_KEYWORDS = [
  'ABORT', 'ACTION', 'ADD', 'ALL', 'ALTER', 'ANALYZE', 'AND', 'AS', 'ASC',
  'ATTACH', 'AUTOINCREMENT', 'BEFORE', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE',
  'CASE', 'CAST', 'CHECK', 'COLLATE', 'COLUMN', 'COMMIT', 'CONFLICT',
  'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT', 'DEFERRABLE', 'DEFERRED',
  'DELETE', 'DESC', 'DETACH', 'DISTINCT', 'DO', 'DROP', 'EACH', 'ELSE', 'END',
  'ESCAPE', 'EXCEPT', 'EXCLUDE', 'EXCLUSIVE', 'EXISTS', 'EXPLAIN', 'FAIL',
  'FILTER', 'FIRST', 'FOLLOWING', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GENERATED',
  'GLOB', 'GROUP', 'GROUPS', 'HAVING', 'IF', 'IGNORE', 'IMMEDIATE', 'IN',
  'INDEX', 'INDEXED', 'INITIALLY', 'INNER', 'INSERT', 'INSTEAD', 'INTERSECT',
  'INTO', 'IS', 'ISNULL', 'JOIN', 'KEY', 'LAST', 'LEFT', 'LIKE', 'LIMIT',
  'MATCH', 'MATERIALIZED', 'NATURAL', 'NOT', 'NOTHING', 'NOTNULL', 'NULL',
  'NULLS', 'OF', 'OFFSET', 'ON', 'OR', 'ORDER', 'OTHERS', 'OUTER', 'OVER',
  'PARTITION', 'PLAN', 'PRAGMA', 'PRECEDING', 'PRIMARY', 'QUERY', 'RAISE',
  'RANGE', 'RECURSIVE', 'REFERENCES', 'REGEXP', 'RELEASE', 'RENAME',
  'REPLACE', 'RESTRICT', 'RETURNING', 'ROLLBACK', 'ROW', 'ROWS', 'SAVEPOINT',
  'SELECT', 'SET', 'TABLE', 'TEMP', 'TEMPORARY', 'THEN', 'TIES', 'TO',
  'TRANSACTION', 'TRIGGER', 'UNBOUNDED', 'UNION', 'UNIQUE', 'UPDATE', 'USING',
  'VACUUM', 'VALUES', 'VIEW', 'VIRTUAL', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
  'WITHOUT'
]

// SQLite 内置函数（聚合 + 标量 + JSON + 日期，只收文档里存在的）
const SQLITE_BUILTIN = [
  'ABS', 'AVG', 'CHANGES', 'COALESCE', 'COUNT', 'DATE', 'DATETIME', 'HEX',
  'IIF', 'INSTR', 'JSON', 'JSON_ARRAY', 'JSON_EXTRACT', 'JSON_INSERT',
  'JSON_OBJECT', 'JSON_QUOTE', 'JSON_REMOVE', 'JSON_REPLACE', 'JSON_SET',
  'GROUP_CONCAT', 'JULIANDAY', 'LAST_INSERT_ROWID', 'LENGTH', 'LOWER',
  'LTRIM', 'MAX', 'MIN', 'NULLIF', 'QUOTE', 'RANDOM', 'RANDOMBLOB', 'REPLACE',
  'ROUND', 'RTRIM', 'STRFTIME', 'SUBSTR', 'SUM', 'TIME', 'TOTAL',
  'TOTAL_CHANGES', 'TRIM', 'TYPEOF', 'UNICODE', 'UPPER', 'ZEROBLOB'
]

// SQLite 声明类型（五大亲和性 + 文档 §3.1.1 列出的常用别名）
const SQLITE_TYPES = [
  'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME',
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'BIGINT', 'INT2', 'INT8', 'CHARACTER',
  'VARCHAR', 'NCHAR', 'NVARCHAR', 'CLOB', 'DOUBLE', 'FLOAT', 'DECIMAL',
  'TIMESTAMP'
]

export const dialectMap = {
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    // 同一协议族（tidb / oceanbase / mariadb）复用本条，归属见 db-engine-family.js
    keywords: MYSQL_KEYWORDS,
    builtin: MYSQL_BUILTIN,
    types: MYSQL_TYPES,
    // 标识符引号：反引号；字符串单引号（高亮器按此判定转义边界）
    quote: '`',
    // # 在 MySQL 是行注释，在 PG 是非法字符 → 高亮器据此决定是否吞到行尾
    hashComment: true,
    // MySQL 字符串吃反斜杠转义（'a\'b'）；PG 标准里反斜杠是普通字符
    backslashEscapes: true,
    // MySQL 的 -- 必须后跟空白才算注释（--1 是减负数）；PG 没有这个限制
    spaceAfterDashes: true,
    // $tag$ ... $tag$（PG 函数体常用）只有 PG 需要
    dollarQuote: false
  },
  postgres: {
    id: 'postgres',
    label: 'PostgreSQL',
    keywords: PG_KEYWORDS,
    builtin: PG_BUILTIN,
    types: PG_TYPES,
    quote: '"',
    hashComment: false,
    // PG 的 E'' 才有反斜杠转义，普通字符串没有 → 别把 'C:\path' 当转义
    backslashEscapes: false,
    spaceAfterDashes: false,
    dollarQuote: true
  },
  sqlite: {
    id: 'sqlite',
    label: 'SQLite',
    keywords: SQLITE_KEYWORDS,
    builtin: SQLITE_BUILTIN,
    types: SQLITE_TYPES,
    // 标准 SQL 双引号标识符（SQLite 另兼容 `x` 与 [x]，但生成的 SQL 统一用双引号）
    quote: '"',
    // `#` 在 SQLite 不是注释（是非法字符），当注释吃会吞掉真语句
    hashComment: false,
    // SQLite 字符串只认 '' 双写，反斜杠是普通字符 → 'C:\path' 就是它自己
    backslashEscapes: false,
    // `--` 后不需要空白，`SELECT 1--1` 在 SQLite 里后半截是注释
    spaceAfterDashes: false,
    // 没有 $tag$...$tag$ 美元引用
    dollarQuote: false
  }
}

/**
 * dbType → 方言 id（`mysql` / `postgres` / `sqlite`）。
 * 与主进程 `db-client/index.js` 的 `dialectOf` 同一口径：safe-clause 的占位符与
 * 词法校验按这个 id 走，两边不一致会出现"渲染层认为合法、主进程判非法"。
 * 引擎归哪个家族由 db-engine-family.js 定点（这里只认"家族 id 与方言条目同名"，
 * mysql / postgres / sqlite 三条都在 dialectMap 里），新增 PG 兼容引擎不用再改这里。
 * 无 SQL 语法的引擎（redis）回落 mysql。
 * @param {string} dbType
 * @returns {'mysql'|'postgres'|'sqlite'}
 */
export function dialectIdOf (dbType) {
  const family = dbEngineFamily(dbType)
  return family === 'redis' ? 'mysql' : family
}

/**
 * 取方言描述；redis 等无 SQL 语法的引擎返回 null（调用方据此隐藏补全入口）
 * @param {string} dbType
 * @returns {object|null}
 */
export function getDialect (dbType) {
  const family = resolveDbEngineFamily(dbType)
  return family ? dialectMap[family] || null : null
}

export function isSqlDialect (dbType) {
  return hasSqlDialect(dbType)
}

/**
 * 方言 → @codemirror/lang-sql 的 SQLDialect.define 参数（供 CM6 高亮与解析）。
 *
 * ⚠️ 词表必须**小写**：lang-sql 的分词器查表用的是 `d.words[word.toLowerCase()]`
 * （dist/index.js 里 tokensFor 的 Identifier 分支），而它建表时按原样存 key。
 * 表里存的是大写（SQL 惯例，补全插入按用户配置再转大小写）→ 直接 join 进去
 * 一个都命中不了，表现为"关键字不高亮"（数字/字符串/注释仍正常，因为它们
 * 不查词表）。
 *
 * @param {object} d getDialect 的返回值
 * @returns {object} 可直接传给 SQLDialect.define
 */
export function cmDialectSpec (d) {
  const lower = list => (list || []).join(' ').toLowerCase()
  return {
    keywords: lower(d.keywords),
    builtin: lower(d.builtin),
    types: lower(d.types),
    // 反引号 / 双引号：决定 `` `us `` 这类未闭合标识符能否被识别为标识符
    identifierQuotes: d.quote,
    // PG 的 # 不是注释；mysql 吞到行尾
    hashComments: d.hashComment,
    // mysql 字符串吃反斜杠转义，PG 不吃（'C:\path' 在 PG 里是普通字符串）
    backslashEscapes: d.backslashEscapes,
    // mysql 的 -- 必须后跟空白才是注释
    spaceAfterDashes: d.spaceAfterDashes,
    // $tag$...$tag$（PG 函数体）只有 PG 需要
    doubleDollarQuotedStrings: d.dollarQuote
  }
}

/**
 * 关键字/内置函数/类型合并去重（补全候选的静态部分）。
 * 顺序固定：keyword → builtin → type，便于同 priority 内按稳定性排序。
 */
export function staticCandidates (dbType) {
  const d = getDialect(dbType)
  if (!d) {
    return []
  }
  return [
    ...d.keywords.map(name => ({ label: name, kind: 'keyword' })),
    ...d.builtin.map(name => ({ label: name, kind: 'function' })),
    ...d.types.map(name => ({ label: name, kind: 'type' }))
  ]
}
