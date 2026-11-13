/**
 * SQL 方言表（阶段4 A 批，设计 §4.7 纪律 1）
 *
 * 唯一真源：编辑器高亮、补全关键字、CREATE TABLE 类型建议、引号/注释规则、
 * **能力位（capabilities）**、**类型改写（typeRewrite）**、**DDL 片段（ddlProfile）**
 * 全部从这里取，**不允许**在组件里另写一份。新增引擎只加一条记录。
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
    dollarQuote: false,
    // ---- N8 能力位：UI 显式降级 / 主进程 op 口径的唯一真源 ----
    // 取值来自 src/app/lib/db-client/*.js 的实测能力，不写在别处。
    capabilities: {
      // 单次 executeSql 可发多条语句（后端 multipleStatements 开启）
      multiStatement: true,
      // 单连接可切换/访问其它库（PG 一个连接只绑一个库）
      crossDatabase: true,
      // 可执行 EXPLAIN ANALYZE（会真跑语句；本工具在 db-explain-tree 主动拒绝，位仍留）
      explainAnalyze: true,
      // 连接级手动事务（BEGIN/COMMIT/ROLLBACK）
      transaction: true,
      // 服务端游标 / 结果集流式（无则 LIMIT 分块）
      serverCursor: false,
      // 元数据树深度：2=schema.table / 1=仅 database.table
      treeDepth: 2,
      // 可否暂存编辑（N2 变更集：改格不落库，统一提交）
      editableStaging: true,
      // 逐列/逐索引 ALTER 能否安全回写（N3b 表设计器入口）。MySQL 的 ALTER TABLE
      // 什么都能改，PG 分动作改，SQLite 只有四形（删列/改类型要重建整表）→ 只读预览。
      alterDdl: true,
      // 能否生成 CREATE TABLE（N7 新建表）。与 alterDdl 不同源：CREATE 要内联
      // PK/UNIQUE/INDEX 与表选项，PG 的序列/默认值、SQLite 的重建语义都还没实测
      // 口径，盲生成最容易错 —— 宁可先不放，报原因让人手写。
      createTableDdl: true
    },
    // 族间类型改写（N8）：从另一家族读到某类型时，映射到本方言的口径。
    // 场景：结构对比 / 跨引擎 DDL 时，PG 的 UUID ↔ MySQL 的 CHAR(36) 这类翻译。
    typeRewrite: {
      UUID: 'CHAR(36)',
      JSONB: 'JSON',
      'DOUBLE PRECISION': 'DOUBLE'
    },
    // DDL 片段模板（N8，供 N3 结构对比生成 ALTER 用）。{col} {type} 占位，
    // quote 由各条记录给出；这里只给"跨语句形状"，方言差异在 quote 上体现。
    ddlProfile: {
      addColumn: 'ALTER TABLE {table} ADD COLUMN {def}',
      dropColumn: 'ALTER TABLE {table} DROP COLUMN {name}',
      changeColumn: 'ALTER TABLE {table} MODIFY COLUMN {def}',
      addIndex: 'ALTER TABLE {table} ADD INDEX {name} ({cols})',
      dropIndex: 'ALTER TABLE {table} DROP INDEX {name}'
    }
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
    dollarQuote: true,
    // ---- N8 能力位：见 mysql 条注释，逐位按后端实测填 ----
    capabilities: {
      // PG 单条连接不允许多语句（postgres.js 显式拒绝）→ UI 多语句相关入口要置灰
      multiStatement: false,
      // PG 一个连接只绑一个库（postgres.js 拒绝跨库，仅引导新开 tab）
      crossDatabase: false,
      // PG 原生支持 EXPLAIN ANALYZE（会真执行）
      explainAnalyze: true,
      transaction: true,
      // PG 主进程走 LIMIT 分块（pgAdmin 的 cursor 手法未采用）
      serverCursor: false,
      treeDepth: 2,
      editableStaging: true,
      // 见 mysql 条：逐列 ALTER 分动作发，形状齐全
      alterDdl: true,
      // CREATE TABLE 内联索引 + 表选项的 PG 口径（序列/默认值）未实测 → 不放行
      createTableDdl: false
    },
    typeRewrite: {
      // 反方向：PG 视角的通用类型已属本族，一般不改写；保留空映射以示对称
      'CHAR(36)': 'UUID'
    },
    ddlProfile: {
      addColumn: 'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {def}',
      dropColumn: 'ALTER TABLE {table} DROP COLUMN IF EXISTS {name}',
      changeColumn: 'ALTER TABLE {table} ALTER COLUMN {name} TYPE {type}',
      addIndex: 'CREATE INDEX {name} ON {table} ({cols})',
      dropIndex: 'DROP INDEX IF EXISTS {name}'
    }
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
    dollarQuote: false,
    // ---- N8 能力位：见 mysql 条注释，逐位按后端实测填 ----
    capabilities: {
      // SQLite 原生不支持多条语句一包发（prepare 单语句；node:sqlite 同）
      multiStatement: false,
      // SQLite 就是一个库文件，无"跨库连接"概念
      crossDatabase: false,
      // SQLite 的 EXPLAIN 不真执行（EXPLAIN QUERY PLAN）
      explainAnalyze: false,
      transaction: true,
      serverCursor: false,
      // SQLite 元数据树只有 database → table（无 schema 层）
      treeDepth: 1,
      editableStaging: true,
      // ALTER 只有 ADD/RENAME/DROP COLUMN 与 RENAME TO 四形：改类型/注释得重建整表
      // 搬数据，盲生成的风险不对等 → 设计器整体只读预览（与 db-ddl-generate 同口径）
      alterDdl: false,
      createTableDdl: false
    },
    // SQLite 类型改写：PG 视角类型落到本族后的存储/展示口径
    typeRewrite: {
      'DOUBLE PRECISION': 'REAL',
      'CHARACTER VARYING': 'TEXT'
    },
    ddlProfile: {
      addColumn: 'ALTER TABLE {table} ADD COLUMN {def}',
      dropColumn: 'ALTER TABLE {table} DROP COLUMN {name}',
      changeColumn: 'ALTER TABLE {table} ALTER COLUMN {name} TYPE {type}',
      addIndex: 'CREATE INDEX {name} ON {table} ({cols})',
      dropIndex: 'DROP INDEX {name}'
    }
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

// ---- N8 能力位访问 ----
// 前端 UI 一律问这两个函数，不直接在组件里读 capabilities 字段 ——
// 这样"某能力没声明"的方言能拿到一个保守默认（false），不会因漏字段而静默放开。

/**
 * 取单能力位。非 SQL 方言 / 未声明的位一律 false（保守降级：功能入口默认关闭）。
 * @param {string} dbType 引擎或方言 id
 * @param {string} key capabilities 键名（multiStatement / crossDatabase / …）
 * @returns {boolean|number} 能力位的值；未声明返回 false
 */
export function capabilityOf (dbType, key) {
  const d = getDialect(dbType)
  if (!d || !d.capabilities) {
    return false
  }
  const v = d.capabilities[key]
  return v === undefined ? false : v
}

/**
 * 语义化的能力查询。给"能力位驱动可见性"的调用方一个自文档的入口，
 * 避免各处散落 capabilityOf(dbType, 'multiStatement') 这种裸 key。
 * @param {string} dbType
 * @returns {object} 与 dialectMap 记录的 capabilities 同形状；未声明位为 false
 */
export function getCapabilities (dbType) {
  const d = getDialect(dbType)
  return (d && d.capabilities) || {
    multiStatement: false,
    crossDatabase: false,
    explainAnalyze: false,
    transaction: false,
    serverCursor: false,
    // treeDepth 是数字（元数据树层数），缺省 0 = 无树；与其它布尔位不同
    treeDepth: 0,
    editableStaging: false,
    alterDdl: false,
    createTableDdl: false
  }
}

/**
 * 是否可暂存编辑（N2 变更集：改格不落库、统一提交）。
 * 合并两条既有硬约束：只读 / 无主键是**连接与表级**条件（调用方在 canStage 判），
 * 这里是**方言级**能力位（redis 无 SQL 无法暂存）。缺省按 false。
 * @param {string} dbType
 * @returns {boolean}
 */
export function canStageDialect (dbType) {
  return capabilityOf(dbType, 'editableStaging')
}

/**
 * 类型改写：把其它家族视角的类型名映射到本方言口径。
 * @param {string} dbType
 * @param {string} typeName 源类型名
 * @returns {string} 映射后的类型；无改写记录则原样返回
 */
export function rewriteType (dbType, typeName) {
  const d = getDialect(dbType)
  const map = (d && d.typeRewrite) || {}
  const hit = map[typeName]
  return hit === undefined ? typeName : hit
}

/**
 * DDL 片段模板：供 N3 结构对比生成 ALTER 时按方言取片段。
 * 未声明的键返回 null（调用方据此对该方言降级：不支持该 DDL 形状就藏掉入口）。
 * @param {string} dbType
 * @param {string} key ddlProfile 键名（addColumn / dropColumn / …）
 * @returns {string|null}
 */
export function ddlProfileOf (dbType, key) {
  const d = getDialect(dbType)
  if (!d || !d.ddlProfile) {
    return null
  }
  const v = d.ddlProfile[key]
  return v === undefined ? null : v
}
