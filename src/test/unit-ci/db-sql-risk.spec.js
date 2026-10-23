// E1 危险 SQL 分级 + 连接级安全带（设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §6）
//
// 为什么用 vm 跑真实源码而不是 require：
// - 源码是 ESM（export），CJS 测试进程里 require 吃不下；
// - 更关键的是**不许出现"测试拷贝"**：分级规则一旦在实现与测试之间漂移，
//   测试就会变成自证。这里直接执行 src 下的同一份文件。
//
// 为什么用"追加导出表达式"而不是模板串拼接源码：
// 源码里全是正则（\s \d \w），经模板串插值会被 JS 字符串转义吃掉反斜杠，
// 测试就会在"看起来全绿"的情况下跑一份被改坏的实现。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const RISK = path.join(ROOT, 'src/client/common/db-sql-risk.js')
const GUARD = path.join(ROOT, 'src/client/common/db-safe-guard.js')

// 需要从实现里取出来的符号（追加到同一段脚本末尾，作为脚本的最后一条表达式返回）
const RISK_EXPORTS = '({ RISK_READ, RISK_WRITE, RISK_TRANSACTION, RISK_DDL, ' +
  'RISK_DANGEROUS, RISK_UNKNOWN, RISK_LEVELS, levelRank, maskSqlLiterals, ' +
  'splitStatements, classifyStatement, classifySql, isAlwaysTrueCondition })'

const GUARD_EXPORTS = '({ BYPASS_TTL_MS, ASKED_LIMIT, createGuardState, dbConnKey, ' +
  'shouldConfirm, grantBypass, clearBypass, isBypassed, bypassLeftMs, ' +
  'bypassLeftMinutes, markAsked, muteLowWrite, unmuteLowWrite, resetGuardState })'

// 源码里的 `export ` 前缀去掉即可在同一段脚本里访问内部声明
function loadFrom (file, exportsExpr) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export /gm, '')
  const sandbox = { Math, Number, String, Set, Map, Array, Object, RegExp, JSON }
  vm.createContext(sandbox)
  return vm.runInContext(src + '\n' + exportsExpr, sandbox)
}

const risk = loadFrom(RISK, RISK_EXPORTS)
const guard = loadFrom(GUARD, GUARD_EXPORTS)

const {
  RISK_READ,
  RISK_WRITE,
  RISK_TRANSACTION,
  RISK_DDL,
  RISK_DANGEROUS,
  RISK_UNKNOWN,
  maskSqlLiterals,
  splitStatements,
  classifyStatement,
  classifySql,
  isAlwaysTrueCondition
} = risk

const {
  ASKED_LIMIT,
  BYPASS_TTL_MS,
  createGuardState,
  dbConnKey,
  shouldConfirm,
  grantBypass,
  clearBypass,
  isBypassed,
  bypassLeftMinutes,
  markAsked,
  muteLowWrite
} = guard

const levelOf = (sql, dialect) => classifySql(sql, dialect || 'mysql').level

describe('db-sql-risk: 掩码（防注释/字面量藏语句）', () => {
  test('掩码与输入等长，且换行被保留', () => {
    const sql = "SELECT 1 -- note\r\n/* block */ SELECT 'x'"
    const masked = maskSqlLiterals(sql, 'mysql')
    assert.equal(masked.length, sql.length, '长度必须一致（偏移才能互用）')
    assert.equal(masked.split('\n').length, sql.split('\n').length, '换行不能丢')
    assert.equal(masked.includes('note'), false, '行注释内容应被清空')
    assert.equal(masked.includes('block'), false, '块注释内容应被清空')
  })

  test("SELECT 'DROP TABLE x' 的字面量被掩掉，DANGEROUS 关键字不外泄", () => {
    const masked = maskSqlLiterals("SELECT 'DROP TABLE x'", 'mysql')
    assert.equal(masked.trim().toUpperCase(), 'SELECT')
  })

  test('mysql 反斜杠转义：\'a\\\'b\' 不会提前结束字符串', () => {
    const sql = "SELECT 'a\\'b' FROM t"
    const masked = maskSqlLiterals(sql, 'mysql')
    assert.equal(masked.includes('b'), false, '整条字符串都应被掩掉')
    assert.ok(masked.toUpperCase().includes('FROM'), '字符串之后的 SQL 必须保留')
  })

  test('mysql 的 -- 后无空白不算注释（SELECT 1--1 是两个减号）', () => {
    const sql = 'SELECT 1--1'
    assert.equal(maskSqlLiterals(sql, 'mysql'), sql, '不得把 --1 当注释吃掉')
    // 反过来：-- 后有空白就是注释
    assert.equal(maskSqlLiterals('SELECT 1 -- x', 'mysql').includes('x'), false)
  })

  test('mysql 的 # 行注释被掩掉；PG 里 # 不是注释', () => {
    assert.equal(maskSqlLiterals('SELECT 1 # DROP', 'mysql').includes('DROP'), false)
    assert.ok(maskSqlLiterals('SELECT 1 # DROP', 'postgres').includes('DROP'))
  })

  test('mysql 反引号标识符被掩掉（列名叫 drop 也不会误判）', () => {
    const lv = levelOf('SELECT `drop` FROM t', 'mysql')
    assert.equal(lv, RISK_READ)
  })

  test("PG 的 E'...' 启用反斜杠转义（E'a\\'b' 是一个字符串）", () => {
    const sql = "SELECT E'a\\'b' FROM t"
    const masked = maskSqlLiterals(sql, 'postgres')
    assert.ok(masked.toUpperCase().includes('FROM'), '字符串结束后应恢复识别')
    assert.equal(masked.includes("'b"), false)
  })

  test('PG 美元引用 $tag$ ... $tag$ 被整段掩掉', () => {
    const sql = 'SELECT $body$ DROP TABLE x $body$ AS v'
    const masked = maskSqlLiterals(sql, 'postgres')
    assert.equal(masked.includes('DROP'), false)
    assert.ok(masked.toUpperCase().includes('AS'))
  })

  test('PG 块注释支持嵌套：/* a /* b */ c */ 整段掩掉', () => {
    const sql = 'SELECT /* a /* b */ DROP */ 1'
    const masked = maskSqlLiterals(sql, 'postgres')
    assert.equal(masked.includes('DROP'), false, '嵌套块注释里的内容必须一并掩掉')
    // mysql 不嵌套：第一个 */ 就结束，DROP 会露出来（这是方言差异的体现）
    assert.ok(maskSqlLiterals(sql, 'mysql').includes('DROP'))
  })
})

describe('db-sql-risk: 切分', () => {
  test('按分号切分，返回 trimmed 的 text 与原文可切片对齐的 start/end', () => {
    const sql = 'SELECT 1;\nUPDATE t SET a=1 WHERE id=2 ;  '
    const parts = splitStatements(sql, 'mysql')
    assert.equal(parts.length, 2)
    assert.equal(parts[0].text, 'SELECT 1')
    assert.equal(parts[1].text, 'UPDATE t SET a=1 WHERE id=2')
    for (const p of parts) {
      assert.equal(sql.slice(p.start, p.end), p.text)
    }
  })

  test('字符串里的分号不切分', () => {
    const parts = splitStatements("SELECT 'a;b' FROM t", 'mysql')
    assert.equal(parts.length, 1)
  })

  test('注释里的分号不切分', () => {
    const parts = splitStatements('SELECT 1 -- a;b\nFROM t', 'mysql')
    assert.equal(parts.length, 1)
  })

  test('CRLF 与孤立 CR 换行都能切分', () => {
    assert.equal(splitStatements('SELECT 1;\r\nSELECT 2;\rSELECT 3', 'mysql').length, 3)
  })

  test('空串 / 只有分号 / 只有注释 → 不抛错且返回空数组', () => {
    // 注意：vm 沙箱里的数组与本 realm 的 Array 原型不同，deepStrictEqual 会误判，
    // 这里只断言结构与长度
    for (const sql of ['', '  ;;  ; ', '-- nothing here\n', '/* only comment */']) {
      const parts = splitStatements(sql, 'mysql')
      assert.ok(Array.isArray(parts), sql)
      assert.equal(parts.length, 0, JSON.stringify(sql))
    }
    const r = classifySql('   ', 'mysql')
    assert.equal(r.level, RISK_READ)
    assert.equal(r.statements.length, 0)
    assert.equal(r.reasons.length, 0)
  })
})

describe('db-sql-risk: 分级（read / transaction / write）', () => {
  test('SELECT / EXPLAIN / SHOW / DESC / DESCRIBE 都是 read', () => {
    for (const sql of [
      'SELECT * FROM t',
      'EXPLAIN SELECT * FROM t',
      'SHOW TABLES',
      'DESC t',
      'DESCRIBE t'
    ]) {
      assert.equal(levelOf(sql), RISK_READ, sql)
    }
  })

  test('WITH ... SELECT 判 read（CTE 体里的词不参与定级）', () => {
    assert.equal(levelOf('WITH x AS (SELECT 1) SELECT * FROM x', 'postgres'), RISK_READ)
  })

  test('EXPLAIN 包着 DELETE 也按 read（不执行）', () => {
    assert.equal(levelOf('EXPLAIN DELETE FROM t', 'postgres'), RISK_READ)
  })

  test('BEGIN / START TRANSACTION / COMMIT / ROLLBACK / SAVEPOINT / RELEASE 都是 transaction', () => {
    for (const sql of [
      'BEGIN',
      'START TRANSACTION',
      'COMMIT',
      'ROLLBACK',
      'SAVEPOINT s1',
      'RELEASE SAVEPOINT s1'
    ]) {
      assert.equal(levelOf(sql), RISK_TRANSACTION, sql)
    }
  })

  test('INSERT / REPLACE 是 write', () => {
    assert.equal(levelOf('INSERT INTO t VALUES (1)'), RISK_WRITE)
    assert.equal(levelOf('REPLACE INTO t VALUES (1)'), RISK_WRITE)
  })

  test('UPDATE / DELETE 带有效 WHERE 是 write', () => {
    assert.equal(levelOf('UPDATE t SET a=1 WHERE id=2'), RISK_WRITE)
    assert.equal(levelOf('DELETE FROM t WHERE id=2'), RISK_WRITE)
  })

  test('子查询里的 WHERE 不能算作主语句的 WHERE（深度为 1）', () => {
    // UPDATE 没有顶层 WHERE → dangerous
    assert.equal(levelOf('UPDATE t SET a=(SELECT 1 FROM u WHERE u.id=1)'), RISK_DANGEROUS)
  })
})

describe('db-sql-risk: 分级（dangerous）', () => {
  test('UPDATE / DELETE 无 WHERE 判 dangerous，理由是人话', () => {
    const u = classifySql('UPDATE t SET a=1', 'mysql')
    assert.equal(u.level, RISK_DANGEROUS)
    assert.ok(u.reasons[0].includes('UPDATE'), '理由要指出语句类型')
    assert.ok(u.reasons[0].includes('WHERE'), '理由要指出缺 WHERE')
    assert.equal(classifySql('DELETE FROM t', 'mysql').level, RISK_DANGEROUS)
  })

  test('WHERE 恒真：1=1 / true / 1 / \'a\'=\'a\' / 2>1 全部 dangerous', () => {
    for (const cond of ['1=1', 'true', 'TRUE', '1', "'a'='a'", '2>1', '1 = 1']) {
      const lv = levelOf('DELETE FROM t WHERE ' + cond)
      assert.equal(lv, RISK_DANGEROUS, 'WHERE ' + cond)
    }
  })

  test('OR 一侧恒真也算恒真；AND 全恒真才算恒真', () => {
    assert.equal(levelOf('UPDATE t SET a=1 WHERE id=1 OR 1=1'), RISK_DANGEROUS)
    assert.equal(levelOf('UPDATE t SET a=1 WHERE 1=1 AND 2>1'), RISK_DANGEROUS)
    // 有一侧不是恒真 → 只是普通写
    assert.equal(levelOf('UPDATE t SET a=1 WHERE 1=1 AND id=3'), RISK_WRITE)
  })

  test('恒假条件（1=2 / 1<>1）不算危险', () => {
    assert.equal(levelOf('DELETE FROM t WHERE 1=2'), RISK_WRITE)
    assert.equal(isAlwaysTrueCondition('1<>1'), false)
  })

  test('空的 WHERE 等价全表操作', () => {
    assert.equal(levelOf('DELETE FROM t WHERE'), RISK_DANGEROUS)
  })

  test('DROP / TRUNCATE / GRANT / REVOKE / FLUSH / SHUTDOWN / KILL 都是 dangerous', () => {
    for (const sql of [
      'DROP TABLE t',
      'DROP DATABASE d',
      'TRUNCATE TABLE t',
      'GRANT ALL ON *.* TO u',
      'REVOKE ALL ON *.* FROM u',
      'FLUSH TABLES',
      'SHUTDOWN',
      'KILL 42'
    ]) {
      assert.equal(levelOf(sql), RISK_DANGEROUS, sql)
    }
  })

  test('SET GLOBAL / SET PERSIST 是 dangerous，普通 SET 落 unknown', () => {
    assert.equal(levelOf('SET GLOBAL max_connections=10'), RISK_DANGEROUS)
    assert.equal(levelOf('SET PERSIST max_connections=10'), RISK_DANGEROUS)
    assert.equal(levelOf('SET NAMES utf8mb4'), RISK_UNKNOWN)
  })

  test('语句名展示带上对象词（DROP TABLE 而不是 DROP）', () => {
    const r = classifySql('DROP TABLE t', 'mysql')
    assert.ok(r.reasons.some(s => s.includes('DROP TABLE')), r.reasons.join('|'))
  })
})

describe('db-sql-risk: 分级（ddl / unknown）', () => {
  test('CREATE / ALTER / RENAME 是 ddl', () => {
    for (const sql of [
      'CREATE TABLE t (a int)',
      'CREATE INDEX i ON t (a)',
      'ALTER TABLE t ADD COLUMN b int',
      'RENAME TABLE a TO b'
    ]) {
      assert.equal(levelOf(sql), RISK_DDL, sql)
    }
  })

  test('无法识别的语句落 unknown 并给出理由', () => {
    const r = classifySql('FROBNICATE ALL THE THINGS', 'mysql')
    assert.equal(r.level, RISK_UNKNOWN)
    assert.ok(r.reasons[0].includes('无法识别'), r.reasons.join('|'))
  })

  test('START 不是 START TRANSACTION 时不按事务处理', () => {
    assert.equal(levelOf('START REPLICA', 'mysql'), RISK_UNKNOWN)
  })
})

describe('db-sql-risk: 注释/字面量不参与定级 + 多语句取最高', () => {
  test('注释里的 DROP 不算危险', () => {
    assert.equal(levelOf('SELECT 1 -- DROP TABLE t'), RISK_READ)
    assert.equal(levelOf('/* DROP TABLE t */ SELECT 1'), RISK_READ)
  })

  test("SELECT 'DROP TABLE x' 判 read", () => {
    assert.equal(levelOf("SELECT 'DROP TABLE x'", 'mysql'), RISK_READ)
  })

  test('多语句取最高级，理由带语句序号', () => {
    const r = classifySql('SELECT 1; DELETE FROM t; ALTER TABLE u ADD c int', 'mysql')
    assert.equal(r.level, RISK_DANGEROUS)
    assert.equal(r.statements.length, 3)
    assert.equal(r.statements[0].level, RISK_READ)
    assert.equal(r.statements[1].level, RISK_DANGEROUS)
    assert.equal(r.statements[2].level, RISK_DDL)
    assert.ok(
      r.reasons.some(s => s.startsWith('第 2 条') && s.includes('DELETE')),
      r.reasons.join('|')
    )
  })

  test('ddl 压过 unknown（认出来的具体理由不能被"无法识别"吞掉）', () => {
    assert.equal(levelOf('ALTER TABLE t ADD c int; FROBNICATE', 'mysql'), RISK_DDL)
  })

  test('redis 方言不抛错（本批不覆盖，但函数要健壮）', () => {
    assert.doesNotThrow(() => classifySql('GET foo', 'redis'))
    assert.equal(classifyStatement('GET foo', 'redis').level, RISK_UNKNOWN)
  })
})

describe('db-sql-risk: MySQL 版本注释（服务端会执行，不能当纯注释）', () => {
  // 为什么专门测这条：mysqldump 产物里全是 `/*!40000 ALTER TABLE … */`，
  // 若按普通注释掩掉，粘一份 dump 就会**零确认**放行 DDL
  test('/*! … */ 里的 DROP 判 dangerous', () => {
    const r = classifySql('/*!50000 DROP TABLE t */', 'mysql')
    assert.equal(r.level, RISK_DANGEROUS)
    assert.equal(r.statements.length, 1, '语句不能被整段丢掉')
  })

  test('MariaDB 的 /*M! … */ 同样参与定级', () => {
    assert.equal(classifySql('/*M!100100 DROP TABLE t */', 'mysql').level, RISK_DANGEROUS)
  })

  test('版本注释里的 ALTER 判 ddl', () => {
    assert.equal(
      classifySql('/*!40000 ALTER TABLE t DISABLE KEYS */', 'mysql').level,
      RISK_DDL
    )
  })

  test('版本注释里的只读语句仍是 read', () => {
    assert.equal(classifySql('/*!50000 SELECT 1 */', 'mysql').level, RISK_READ)
  })

  test('方言差异：同样的写法在 PG 里只是普通注释', () => {
    const r = classifySql('/*!50000 DROP TABLE t */', 'postgres')
    assert.equal(r.level, RISK_READ)
    assert.equal(r.statements.length, 0)
  })

  test('普通块注释与普通行注释仍被忽略（不误报）', () => {
    assert.equal(classifySql('/* DROP TABLE t */', 'mysql').level, RISK_READ)
    assert.equal(classifySql('SELECT 1 -- DROP TABLE t', 'mysql').level, RISK_READ)
    // 普通注释 + 真语句：注释整段掩掉，只剩 SELECT → read（版本注释的反例）
    assert.equal(classifySql('/* 普通注释 DROP TABLE t */ SELECT 1', 'mysql').level, RISK_READ)
  })

  test('版本注释里的恒真 WHERE 不会降级成 write（结尾 */ 不许污染条件文本）', () => {
    // 回归：开标签掩掉后 `*/` 曾留在掩码里，条件文本变成 ` 1=1 */`，恒真判定失效
    assert.equal(levelOf('/*!50000 DELETE FROM t WHERE 1=1 */'), RISK_DANGEROUS)
    assert.equal(levelOf('/*!50000 UPDATE t SET a=1 WHERE true */'), RISK_DANGEROUS)
    // 有真实条件的仍判 write（别为了修恒真把普通条件也判危险）
    assert.equal(levelOf('/*!50000 DELETE FROM t WHERE id=1 */'), RISK_WRITE)
  })

  test('掩码里不许残留 */（钉住掩码层，消费点那层不可证伪）', () => {
    // 这条钉的是掩码层：条件文本有两道**互为等价实现**的处理——掩码层把散落的 `*/`
    // 抹成空格，消费点在 condText 末尾再 strip 一次。实测（4 变体 × 31 输入）：
    //   删掩码层 → 级别/语句数 0 变化，差异全部落在 mask 文本上
    //   删消费点 → 连 mask 都是零差异（等价代码，任何黑盒断言都区分不了）
    //   两层都删 → 7 条 dangerous 降级成 write
    // 所以上面那条恒真断言只对"双删"敏感、对单删全盲；能独立打红"掩码层被删"的
    // 只有掩码文本本身。消费点那层（L2）没有对应的断言，不是漏了，是**不可证伪**。
    //
    // 断言写成不变量（"任何输入、任何方言，掩码都不含 `*/`"）而不是精确空格数：
    // 空格数属实现细节，将来 blank() 换个填充字符就会假红，而不变量不会。
    const samples = [
      ['DELETE */ FROM t', 'mysql'],
      ['SELECT */ ; DROP TABLE t', 'mysql'],
      ['/*!50000 DELETE FROM t WHERE 1=1 */', 'mysql'],
      ['/*M!100100 UPDATE t SET a=1 WHERE true */', 'mysql'],
      // 下面三条本来就由别的分支挡掉（字面量 / 美元引用 / 成对块注释），
      // 列在这里是把不变量的覆盖面钉全：不是靠散落分支兜住的
      ["SELECT 'a*/' FROM t", 'mysql'],
      ['SELECT $tag$ */ $tag$', 'postgres'],
      ['/* a /* b */ c */ SELECT 1', 'postgres']
    ]
    for (const [sql, dialect] of samples) {
      assert.ok(!maskSqlLiterals(sql, dialect).includes('*/'), sql)
    }
    // "归一化后语句仍完整"：散落 `*/` 只该被空格替换，不能把词粘在一起
    assert.equal(
      maskSqlLiterals('DELETE */ FROM t', 'mysql').replace(/\s+/g, ' ').trim(),
      'DELETE FROM t'
    )
    // 等长 + `;` 位置不变是 blank() 的契约（掩码与原文 offsets 互用），
    // 防的是"替换成空串"那类变异；切分点也不能被掩码移动
    const sql = "SELECT 'a' */ ; DROP TABLE t"
    const masked = maskSqlLiterals(sql, 'mysql')
    assert.equal(masked.length, sql.length)
    assert.equal(masked.indexOf(';'), sql.indexOf(';'))
  })
})

describe('db-sql-risk: EXPLAIN ANALYZE 会真正执行语句', () => {
  // PG 的 ANALYZE 选项会真正执行被解释的语句；设计表里"EXPLAIN → read"在这一形态上不成立
  test('EXPLAIN ANALYZE DELETE 判 dangerous', () => {
    assert.equal(levelOf('EXPLAIN ANALYZE DELETE FROM t', 'postgres'), RISK_DANGEROUS)
  })

  test('选项写在括号里也要识别：EXPLAIN (ANALYZE, BUFFERS) DELETE', () => {
    assert.equal(
      levelOf('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t', 'postgres'),
      RISK_DANGEROUS
    )
  })

  test('EXPLAIN ANALYZE UPDATE：有 WHERE 是 write，无 WHERE 是 dangerous', () => {
    assert.equal(
      levelOf('EXPLAIN ANALYZE UPDATE t SET a=1 WHERE id=2', 'postgres'),
      RISK_WRITE
    )
    assert.equal(levelOf('EXPLAIN ANALYZE UPDATE t SET a=1', 'postgres'), RISK_DANGEROUS)
    // 括号形式同理：ANALYZE 一样会让语句真正执行
    assert.equal(levelOf('EXPLAIN (ANALYZE) UPDATE t SET a=1', 'postgres'), RISK_DANGEROUS)
    assert.equal(
      levelOf('EXPLAIN (ANALYZE) UPDATE t SET a=1 WHERE id=2', 'postgres'),
      RISK_WRITE
    )
  })

  test('EXPLAIN ANALYZE SELECT 仍是 read', () => {
    assert.equal(levelOf('EXPLAIN ANALYZE SELECT * FROM t', 'postgres'), RISK_READ)
    assert.equal(levelOf('EXPLAIN (ANALYZE) SELECT 1', 'postgres'), RISK_READ)
  })

  test('理由要点明"会真正执行"，否则用户会以为工具认错了自己的 EXPLAIN', () => {
    const r = classifySql('EXPLAIN ANALYZE DELETE FROM t', 'postgres')
    assert.ok(r.reasons[0].includes('EXPLAIN ANALYZE'), r.reasons.join('|'))
    assert.ok(r.reasons[0].includes('DELETE'), r.reasons.join('|'))
  })

  test('不带 ANALYZE 的 EXPLAIN 保持 read（不执行）', () => {
    assert.equal(levelOf('EXPLAIN DELETE FROM t', 'postgres'), RISK_READ)
    assert.equal(levelOf('EXPLAIN (VERBOSE) DELETE FROM t', 'postgres'), RISK_READ)
  })

  test('ANALYZE 包着 DDL / 认不出主语句时不许回落 read', () => {
    // 变异定位指引：这条同时依赖两层，单独坏了都红，所以它负责"报警"、不负责"定位"。
    //   本测试红 + 下面「裸 EXPLAIN ANALYZE」也红 → analyze 检测层坏了（target 没机会生效）
    //   本测试红 + 下面「裸 EXPLAIN ANALYZE」仍绿 → target 识别层坏了（退回"第一个主语句词"
    //   会跳过 CREATE 取到 AS 后面的 SELECT，实测 ddl → read）
    // 为什么这里不写 `EXPLAIN CREATE TABLE n AS SELECT 1`（不带 ANALYZE → read）：
    // 无 ANALYZE 时 EXPLAIN 恒为 read，与 target 取哪个词完全无关——变异实测该断言在
    // 原版 / target 退化 / analyze 退化三种配置下全绿，是假信心断言，故不写。
    // CREATE TABLE AS 在 ANALYZE 下会真建表；旧实现会被里面的 SELECT 骗成 read
    assert.equal(levelOf('EXPLAIN ANALYZE CREATE TABLE n AS SELECT 1', 'postgres'), RISK_DDL)
    assert.equal(levelOf('EXPLAIN ANALYZE ALTER TABLE n ADD c int', 'postgres'), RISK_DDL)
    assert.equal(levelOf('EXPLAIN ANALYZE DROP TABLE t', 'postgres'), RISK_DANGEROUS)
    // 认不出主语句（EXECUTE / CALL）→ unknown（会问一次），绝不能 read 放行
    assert.equal(levelOf('EXPLAIN ANALYZE EXECUTE p', 'postgres'), RISK_UNKNOWN)
    assert.equal(levelOf('EXPLAIN ANALYZE CALL p()', 'postgres'), RISK_UNKNOWN)
    // 连主语句词都找不到（选项全在括号里）→ unknown
    assert.equal(levelOf('EXPLAIN ANALYZE (FORMAT JSON)', 'postgres'), RISK_UNKNOWN)
  })

  test('裸 EXPLAIN ANALYZE 不许静默 read（analyze 但无目标 = unknown）', () => {
    // 这条是 analyze 检测层的**唯一症状**：target 选谁都无关（本来就没有 target），
    // 只有 analyze 标志被读丢时才会掉成 read。所以上一组红、这条绿 = target 层坏；
    // 这条也红 = analyze 层坏。
    const r = classifySql('EXPLAIN ANALYZE', 'postgres')
    assert.equal(r.level, RISK_UNKNOWN)
    assert.ok(r.reasons[0].includes('EXPLAIN ANALYZE'), r.reasons.join('|'))
    // 反过来：裸 EXPLAIN（无 ANALYZE）不执行，保持 read
    assert.equal(levelOf('EXPLAIN', 'postgres'), RISK_READ)
  })

  test('FORMAT=TREE 的取值不许被当成主语句（MySQL EXPLAIN ANALYZE 默认格式）', () => {
    // TREE 是 FORMAT 的取值，词表漏了它就会把 TREE 当主语句，
    // 于是 `… FORMAT=TREE DELETE` 被误判成 read 静默放行
    assert.equal(
      levelOf('EXPLAIN ANALYZE FORMAT=TREE DELETE FROM t', 'mysql'),
      RISK_DANGEROUS
    )
    // 回归：其它取值走同一条路径，不能被这次补词改坏
    assert.equal(
      levelOf('EXPLAIN ANALYZE FORMAT=JSON DELETE FROM t', 'mysql'),
      RISK_DANGEROUS
    )
    assert.equal(
      levelOf('EXPLAIN ANALYZE FORMAT=TREE SELECT 1', 'mysql'),
      RISK_READ
    )
  })
})

describe('db-safe-guard: 分级 → 是否确认', () => {
  const run = (opts) => shouldConfirm(Object.assign({
    state: createGuardState(),
    connKey: 'c1',
    scope: 's1',
    now: 1000
  }, opts))

  test('read / transaction 不弹', () => {
    assert.equal(run({ level: 'read' }).need, false)
    assert.equal(run({ level: 'transaction' }).need, false)
  })

  test('write 首次弹，但不要求输库名（非生产）', () => {
    const r = run({ level: 'write' })
    assert.equal(r.need, true)
    assert.equal(r.requireDbName, false)
    assert.ok(r.reason.length > 0)
  })

  test('静音低风险写之后不再弹', () => {
    const state = createGuardState()
    assert.equal(run({ level: 'write', state, scope: 'a' }).need, true)
    muteLowWrite(state, 'c1')
    assert.equal(run({ level: 'write', state, scope: 'b' }).need, false)
    // 静音只对 write 生效，ddl 依旧要问
    assert.equal(run({ level: 'ddl', state, scope: 'c' }).need, true)
  })

  test('ddl / dangerous / unknown 每次都弹（不同批次不共享记忆）', () => {
    const state = createGuardState()
    for (const level of ['ddl', 'dangerous', 'unknown']) {
      assert.equal(run({ level, state, scope: level + '-1' }).need, true, level + ' 第一批')
      markAsked(state, level + '-1')
      assert.equal(run({ level, state, scope: level + '-1' }).need, false, level + ' 同批不再问')
      assert.equal(run({ level, state, scope: level + '-2' }).need, true, level + ' 新批次要再问')
    }
  })

  test('production：所有非 read 语句都要输库名（ddl/write 同样更严）', () => {
    const state = createGuardState()
    for (const level of ['write', 'ddl', 'dangerous', 'unknown']) {
      const r = shouldConfirm({
        level,
        production: true,
        state,
        connKey: 'c1',
        scope: 'p-' + level,
        now: 1000
      })
      assert.equal(r.need, true, level)
      assert.equal(r.requireDbName, true, level + ' 必须输库名')
    }
  })

  test('production：transaction / read 仍不弹（否则每次 COMMIT 都要输库名）', () => {
    const state = createGuardState()
    assert.equal(shouldConfirm({
      level: 'transaction',
      production: true,
      state,
      connKey: 'c1',
      scope: 'p1',
      now: 1000
    }).need, false)
    assert.equal(shouldConfirm({
      level: 'read',
      production: true,
      state,
      connKey: 'c1',
      scope: 'p2',
      now: 1000
    }).need, false)
  })

  test('production 下静音无效（安全带的核心场景不允许被静音）', () => {
    const state = createGuardState()
    muteLowWrite(state, 'c1')
    assert.equal(shouldConfirm({
      level: 'write',
      production: true,
      state,
      connKey: 'c1',
      scope: 'p1',
      now: 1000
    }).need, true)
  })

  test('脏 level 值按 unknown 处理（宁可多问一次）', () => {
    const r = run({ level: 'banana' })
    assert.equal(r.need, true)
    assert.equal(r.reason, '无法识别语句类型，按需确认')
  })
})

describe('db-safe-guard: 临时解除 5 分钟（假时钟）', () => {
  test('授予后 4 分 59 秒仍放行，满 5 分钟自动恢复', () => {
    const state = createGuardState()
    const t0 = 1000000
    const expireAt = grantBypass(state, 'c1', t0)
    assert.equal(expireAt, t0 + BYPASS_TTL_MS)
    assert.equal(BYPASS_TTL_MS, 5 * 60 * 1000)
    // 生效期内：不弹
    assert.equal(shouldConfirm({
      level: 'dangerous', production: true, state, connKey: 'c1', scope: 's', now: t0 + 299000
    }).need, false)
    // 到点：恢复
    assert.equal(shouldConfirm({
      level: 'dangerous', production: true, state, connKey: 'c1', scope: 's2', now: t0 + BYPASS_TTL_MS
    }).need, true)
    assert.equal(isBypassed(state, 'c1', t0 + BYPASS_TTL_MS), false, '过期项应被清掉')
  })

  test('剩余分钟向上取整，过期后归零', () => {
    const state = createGuardState()
    grantBypass(state, 'c1', 0)
    assert.equal(bypassLeftMinutes(state, 'c1', 0), 5)
    assert.equal(bypassLeftMinutes(state, 'c1', 60000), 4)
    assert.equal(bypassLeftMinutes(state, 'c1', BYPASS_TTL_MS), 0)
  })

  test('手动恢复立即生效', () => {
    const state = createGuardState()
    grantBypass(state, 'c1', 0)
    clearBypass(state, 'c1')
    assert.equal(isBypassed(state, 'c1', 1000), false)
  })
})

describe('db-safe-guard: asked 记忆与连接身份', () => {
  test('asked 上限 50，超出淘汰最旧', () => {
    const state = createGuardState()
    for (let i = 0; i < ASKED_LIMIT + 1; i++) {
      markAsked(state, 'scope-' + i)
    }
    assert.equal(state.asked.size, ASKED_LIMIT)
    assert.equal(state.asked.has('scope-0'), false, '最旧的应被淘汰')
    assert.equal(state.asked.has('scope-' + ASKED_LIMIT), true, '最新的必须保留')
  })

  test('重复 markAsked 不增长（并刷新到"最近使用"）', () => {
    const state = createGuardState()
    markAsked(state, 'a')
    markAsked(state, 'b')
    markAsked(state, 'a')
    assert.equal(state.asked.size, 2)
    // 再灌到刚好溢出 1 个：'a' 刚用过应留下，'b' 是最旧的应被淘汰
    for (let i = 0; i < ASKED_LIMIT - 1; i++) {
      markAsked(state, 'x-' + i)
    }
    assert.equal(state.asked.size, ASKED_LIMIT)
    assert.equal(state.asked.has('b'), false)
    assert.equal(state.asked.has('a'), true)
  })

  test('空 scope 不登记（避免把"没有批次"当成一批）', () => {
    const state = createGuardState()
    markAsked(state, '')
    assert.equal(state.asked.size, 0)
  })

  test('连接身份区分引擎/主机/端口/用户/库', () => {
    const base = { dbType: 'mysql', dbHost: 'h', dbPort: 3306, dbUser: 'u', dbName: 'd1' }
    const other = Object.assign({}, base, { dbName: 'd2' })
    assert.notEqual(dbConnKey(base), dbConnKey(other))
    assert.equal(dbConnKey(base), dbConnKey(Object.assign({}, base)))
    assert.equal(dbConnKey({}), '||||')
  })

  test('同一连接放开后，另一个连接仍受保护', () => {
    const state = createGuardState()
    grantBypass(state, 'c1', 0)
    assert.equal(shouldConfirm({
      level: 'dangerous', production: true, state, connKey: 'c2', scope: 's', now: 1000
    }).need, true)
  })
})
