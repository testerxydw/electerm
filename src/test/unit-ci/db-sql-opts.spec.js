// A-8：编辑器六项开关的配置层单测
//
// 这层是纯函数（零依赖），真正的 CM6 装配在 db-sql-editor.jsx（node 环境挂不了 DOM）。
// 断言重点是"错一次就静默错位"的地方：默认值、手改 config 写进来的非布尔值、
// 词条 key 漏配（漏了界面会显示 key 原文）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '../../..')
const OPTS = path.join(ROOT, 'src/client/common/db-sql-opts.js')
const EXTRA = path.join(ROOT, 'src/app/common/locales-extra.js')

function load () {
  const strip = p => fs.readFileSync(p, 'utf8').replace(/^export /gm, '')
  const sandbox = {}
  vm.createContext(sandbox)
  return vm.runInContext(
    `(function () { ${strip(OPTS)};
      return {
        SQL_EDITOR_OPTIONS, SQL_EDITOR_DEFAULTS,
        readSqlEditorOpts, normalizeSqlEditorOpts, toggleSqlEditorOpt
      }
    })()`,
    sandbox
  )
}

const api = load()
const { SQL_EDITOR_OPTIONS, SQL_EDITOR_DEFAULTS } = api
const extra = require(EXTRA)

describe('A-8 六项定义', () => {
  test('正好六项，且覆盖设计里的行号/换行/补全/括号/当前行/折叠', () => {
    assert.deepEqual(
      Array.from(SQL_EDITOR_OPTIONS).map(o => o.key),
      ['lineNumbers', 'lineWrap', 'autoComplete', 'bracketMatch', 'activeLine', 'fold']
    )
  })

  test('config 键与词条 key 都不重复（重复会导致两个开关联动）', () => {
    const configs = Array.from(SQL_EDITOR_OPTIONS).map(o => o.config)
    const labels = Array.from(SQL_EDITOR_OPTIONS).map(o => o.label)
    assert.equal(new Set(configs).size, 6)
    assert.equal(new Set(labels).size, 6)
  })

  test('默认值：行号/补全/括号/当前行 开，换行/折叠 关', () => {
    assert.deepEqual(Object.assign({}, SQL_EDITOR_DEFAULTS), {
      lineNumbers: true,
      lineWrap: false,
      autoComplete: true,
      bracketMatch: true,
      activeLine: true,
      fold: false
    })
  })

  test('六个词条 key 在中英两份补充词条里都存在', () => {
    for (const o of SQL_EDITOR_OPTIONS) {
      assert.ok(extra.en[o.label], `缺英文词条 ${o.label}`)
      assert.ok(extra.zh_cn[o.label], `缺中文词条 ${o.label}`)
    }
  })
})

describe('A-8 读配置', () => {
  test('没配过 → 全默认', () => {
    assert.deepEqual(Object.assign({}, api.readSqlEditorOpts({})), Object.assign({}, SQL_EDITOR_DEFAULTS))
    assert.deepEqual(Object.assign({}, api.readSqlEditorOpts(null)), Object.assign({}, SQL_EDITOR_DEFAULTS))
  })

  test('配过就按配置走（含把默认开的关掉）', () => {
    const o = api.readSqlEditorOpts({
      dbSqlLineNumbers: false,
      dbSqlFold: true,
      dbSqlLineWrap: true
    })
    assert.equal(o.lineNumbers, false)
    assert.equal(o.fold, true)
    assert.equal(o.lineWrap, true)
    // 没动的项仍取默认
    assert.equal(o.autoComplete, true)
  })

  test('非布尔值一律回落默认（手改 config 写成 "true"/1 很常见）', () => {
    const o = api.readSqlEditorOpts({
      dbSqlLineNumbers: 'false',
      dbSqlFold: 1,
      dbSqlAutoComplete: null
    })
    assert.equal(o.lineNumbers, true, '字符串 "false" 不能当 false 用，否则开关与实际不符')
    assert.equal(o.fold, false)
    assert.equal(o.autoComplete, true)
  })
})

describe('A-8 归一化与翻转', () => {
  test('null / 缺字段 / 未知字段都不抛错，也不透传', () => {
    assert.deepEqual(Object.assign({}, api.normalizeSqlEditorOpts(null)), Object.assign({}, SQL_EDITOR_DEFAULTS))
    const o = api.normalizeSqlEditorOpts({ fold: true, nope: true })
    assert.equal(o.fold, true)
    assert.ok(!('nope' in o))
    assert.equal(Object.keys(o).length, 6)
  })

  test('翻转返回"补丁"而不是整份配置（setConfig 是浅合并）', () => {
    const r = api.toggleSqlEditorOpt({ fold: false }, 'fold')
    assert.equal(r.value, true)
    assert.deepEqual(Object.assign({}, r.patch), { dbSqlFold: true })
    assert.equal(r.config, 'dbSqlFold')
    // 补丁只能有一个键：整份写回会覆盖并发改的其他配置
    assert.equal(Object.keys(r.patch).length, 1)
  })

  test('翻转不认识的 key 返回 null（不静默写脏配置）', () => {
    assert.equal(api.toggleSqlEditorOpt({}, 'nope'), null)
  })
})
