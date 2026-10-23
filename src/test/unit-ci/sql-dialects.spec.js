// A 批方言表：纯数据直测（ESM 源码，vm 加载方式与 db-sql-format.spec 一致）
// 方言表是 A-3/A-4/A-5 补全与高亮的唯一真源，串味（PG 关键字漏进 MySQL）会
// 直接表现为"补出根本不存在的语法"，所以这里按引擎逐个钉死。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = path.join(__dirname, '../../client/common/sql-dialects.js')

function loadFns () {
  let src = fs.readFileSync(SRC, 'utf8')
  src = src.replace(/^export /gm, '')
  const sandbox = {}
  vm.createContext(sandbox)
  return vm.runInContext(
    `(function () { ${src}; return { dialectMap, getDialect, isSqlDialect, staticCandidates } })()`,
    sandbox
  )
}

describe('sql-dialects: dbType → 方言映射', () => {
  const { getDialect, isSqlDialect } = loadFns()

  test('mysql 直连', () => {
    const d = getDialect('mysql')
    assert.ok(d, 'mysql 必须有方言')
    assert.equal(d.id, 'mysql')
  })

  test('tidb / oceanbase 复用 mysql 方言（同协议）', () => {
    assert.equal(getDialect('tidb').id, 'mysql')
    assert.equal(getDialect('oceanbase').id, 'mysql')
  })

  test('postgres 独立方言', () => {
    assert.equal(getDialect('postgres').id, 'postgres')
  })

  test('redis 无 SQL 语法 → null，且 isSqlDialect 为 false', () => {
    assert.equal(getDialect('redis'), null)
    assert.equal(isSqlDialect('redis'), false)
  })

  test('未知 dbType 不抛错，返回 null（降级不崩）', () => {
    assert.equal(getDialect('sqlserver'), null)
    assert.equal(getDialect(undefined), null)
    assert.equal(getDialect(''), null)
  })
})

describe('sql-dialects: 关键字表完整性', () => {
  const { dialectMap } = loadFns()

  test('两个方言的关键字都非空且量级合理（> 100）', () => {
    for (const id of ['mysql', 'postgres']) {
      assert.ok(dialectMap[id].keywords.length > 100, `${id} 关键字过少`)
    }
  })

  test('关键字全大写（补全按大写存储，展示层再按配置转大小写）', () => {
    for (const id of ['mysql', 'postgres']) {
      const bad = dialectMap[id].keywords.filter(k => k !== k.toUpperCase())
      // vm 沙箱数组与宿主数组不同 realm，deepStrictEqual 会误判，按长度断言
      assert.equal(bad.length, 0, `${id} 存在非大写关键字: ${bad.slice(0, 5)}`)
    }
  })

  test('关键字无重复（重复会让补全列表出现两条同项）', () => {
    for (const id of ['mysql', 'postgres']) {
      const seen = new Set()
      const dup = []
      for (const k of dialectMap[id].keywords) {
        if (seen.has(k)) {
          dup.push(k)
        }
        seen.add(k)
      }
      assert.equal(dup.length, 0, `${id} 关键字重复: ${dup.slice(0, 5)}`)
    }
  })

  test('builtin / types 同样无重复', () => {
    for (const id of ['mysql', 'postgres']) {
      const d = dialectMap[id]
      for (const field of ['builtin', 'types']) {
        assert.equal(
          new Set(d[field]).size,
          d[field].length,
          `${id}.${field} 有重复项`
        )
      }
    }
  })

  test('MySQL 必有关键字齐全', () => {
    const kw = dialectMap.mysql.keywords
    for (const k of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'LIMIT', 'SHOW', 'DESCRIBE']) {
      assert.ok(kw.includes(k), `MySQL 缺 ${k}`)
    }
  })

  test('PostgreSQL 特有语法必须在 pg 表里', () => {
    const kw = dialectMap.postgres.keywords
    for (const k of ['RETURNING', 'ILIKE', 'LATERAL', 'MATERIALIZED', 'CONFLICT']) {
      assert.ok(kw.includes(k), `PostgreSQL 缺 ${k}`)
    }
  })

  test('PG 特有关键字不得漏进 MySQL（方言串味）', () => {
    const kw = dialectMap.mysql.keywords
    for (const k of ['RETURNING', 'ILIKE', 'LATERAL', 'MATERIALIZED']) {
      assert.ok(!kw.includes(k), `MySQL 里不该有 PG 专属关键字 ${k}`)
    }
  })

  test('类型名覆盖各自主流类型', () => {
    assert.ok(dialectMap.mysql.types.includes('VARCHAR'))
    assert.ok(dialectMap.mysql.types.includes('JSON'))
    assert.ok(dialectMap.postgres.types.includes('JSONB'))
    assert.ok(dialectMap.postgres.types.includes('UUID'))
  })
})

describe('sql-dialects: 词法开关', () => {
  const { dialectMap } = loadFns()

  test('标识符引号：mysql 反引号 / pg 双引号', () => {
    assert.equal(dialectMap.mysql.quote, '`')
    assert.equal(dialectMap.postgres.quote, '"')
  })

  test('# 行注释只有 MySQL 有', () => {
    assert.equal(dialectMap.mysql.hashComment, true)
    assert.equal(dialectMap.postgres.hashComment, false)
  })

  test('反斜杠转义只有 MySQL 有（PG 的 C:\\path 是普通字符串）', () => {
    assert.equal(dialectMap.mysql.backslashEscapes, true)
    assert.equal(dialectMap.postgres.backslashEscapes, false)
  })

  test('-- 后必须空白才是注释，只有 MySQL 需要', () => {
    assert.equal(dialectMap.mysql.spaceAfterDashes, true)
    assert.equal(dialectMap.postgres.spaceAfterDashes, false)
  })

  test('$tag$ 引号只有 PG 需要', () => {
    assert.equal(dialectMap.mysql.dollarQuote, false)
    assert.equal(dialectMap.postgres.dollarQuote, true)
  })
})

describe('sql-dialects: staticCandidates 输出', () => {
  const { staticCandidates } = loadFns()

  test('候选数 = keywords + builtin + types', () => {
    const { dialectMap } = loadFns()
    for (const id of ['mysql', 'postgres']) {
      const d = dialectMap[id]
      const out = staticCandidates(id)
      assert.equal(out.length, d.keywords.length + d.builtin.length + d.types.length)
    }
  })

  test('每项都带 label 与 kind，kind 只有三类', () => {
    const out = staticCandidates('mysql')
    const kinds = new Set(out.map(o => o.kind))
    assert.deepEqual([...kinds].sort(), ['function', 'keyword', 'type'])
    assert.ok(out.every(o => typeof o.label === 'string' && o.label.length))
  })

  test('tidb 走 mysql 候选（同一份表）', () => {
    assert.deepEqual(staticCandidates('tidb'), staticCandidates('mysql'))
  })

  test('非 SQL 引擎返回空数组（调用方据此隐藏补全入口）', () => {
    assert.equal(staticCandidates('redis').length, 0)
    assert.equal(staticCandidates('unknown').length, 0)
  })
})
