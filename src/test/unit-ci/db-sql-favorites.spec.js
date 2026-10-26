const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/app/lib/db-sql-favorites.js')

// B 批：SQL 查询收藏主进程存储（设计 §11）。纯 fs 无 electron 依赖，
// 文件路径用临时目录隔离；对齐 db-sql-history.spec 的测法
const f = require(MOD)

const entry = (sql, extra = {}) => ({
  id: '',
  title: 't',
  sql,
  dbType: 'mysql',
  ...extra
})

describe('db-sql-favorites (main-process file store)', () => {
  let dir
  let file

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-sql-favorites-'))
    file = path.join(dir, 'db-sql-favorites.json')
  })

  test('保存时无 id 自动生成，返回列表最新在前', () => {
    const list = f.saveFavorite(entry('SELECT 1'), file)
    assert.equal(list.length, 1)
    assert.ok(list[0].id.startsWith('fav-'))
    const list2 = f.saveFavorite(entry('SELECT 2'), file)
    assert.equal(list2.length, 2)
    assert.equal(list2[0].sql, 'SELECT 2')
    // 跨调用（跨启动）可读
    assert.equal(f.listFavorites(file).length, 2)
  })

  test('upsert：带已存在 id 保存即覆盖，不追加', () => {
    const l1 = f.saveFavorite(entry('SELECT 1', { id: 'fav-a' }), file)
    assert.equal(l1[0].id, 'fav-a')
    const l2 = f.saveFavorite(entry('SELECT 9', { id: 'fav-a', title: 'renamed' }), file)
    assert.equal(l2.length, 1)
    assert.equal(l2[0].sql, 'SELECT 9')
    assert.equal(l2[0].title, 'renamed')
  })

  test('白名单字段：密码/连接串等额外字段一律不落盘', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'x', password: 'p@ss', connStr: 'mysql://u:p@h' }), file)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const item = raw[0]
    assert.equal(item.password, undefined)
    assert.equal(item.connStr, undefined)
    assert.deepEqual(Object.keys(item).sort(), ['dbType', 'id', 'sql', 'title', 'ts'])
  })

  test('空语句保存是 no-op', () => {
    f.saveFavorite({ title: 'x', sql: '' }, file)
    assert.equal(f.listFavorites(file).length, 0)
    f.saveFavorite(null, file)
    assert.equal(f.listFavorites(file).length, 0)
  })

  test('删除：按 id 移除并落盘；id 不存在原样返回', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a' }), file)
    f.saveFavorite(entry('SELECT 2', { id: 'b' }), file)
    const l1 = f.removeFavorite('a', file)
    assert.equal(l1.length, 1)
    assert.equal(l1[0].id, 'b')
    const l2 = f.removeFavorite('nope', file)
    assert.equal(l2.length, 1)
    // 落盘确认
    assert.equal(f.listFavorites(file).length, 1)
  })

  test('上限 500：超出丢最旧（保存置顶）', () => {
    for (let i = 0; i < 505; i++) {
      f.saveFavorite(entry('SELECT ' + i, { id: 'k' + i }), file)
    }
    const list = f.listFavorites(file)
    assert.equal(list.length, 500)
    assert.equal(list[0].id, 'k504')
    assert.equal(list[499].id, 'k5')
  })

  test('导入：新 id 追加、重复 id 覆盖（不重复追加）', () => {
    f.saveFavorite(entry('old-1', { id: 'a' }), file)
    const r = f.importFavorites([
      { id: 'a', title: 'shared', sql: 'new-1', dbType: 'pg' },
      { id: 'b', title: 'shared2', sql: 'new-2', dbType: 'mysql' }
    ], file)
    assert.equal(r.imported, 1)
    assert.equal(r.overwritten, 1)
    assert.equal(r.list.length, 2)
    const item = r.list.find(x => x.id === 'a')
    assert.equal(item.sql, 'new-1')
    assert.equal(item.title, 'shared')
  })

  test('导入：无 id 生成、非法条目（无 sql/非对象）跳过', () => {
    const r = f.importFavorites([
      { title: 'no-sql' },
      'garbage',
      null,
      { title: 'no-id', sql: 'SELECT 1' }
    ], file)
    assert.equal(r.list.length, 1)
    assert.equal(r.list[0].title, 'no-id')
    assert.ok(r.list[0].id.startsWith('fav-'))
    assert.equal(r.imported, 1)
    assert.equal(r.overwritten, 0)
  })

  test('导入：非数组输入安全返回空结果', () => {
    const r = f.importFavorites(null, file)
    assert.equal(r.imported, 0)
    assert.equal(r.list.length, 0)
  })

  test('导出：白名单清洗后写 JSON，且导出文件可再导入（往返一致）', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a' }), file)
    const list = f.listFavorites(file)
    const out = path.join(dir, 'share.json')
    const n = f.exportFavorites(list, out)
    assert.equal(n, 1)
    const raw = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.equal(raw.length, 1)
    assert.equal(raw[0].sql, 'SELECT 1')
    // 往返：另一份空存储导入该文件
    const file2 = path.join(dir, 'other.json')
    const r = f.importFavorites(raw, file2)
    assert.equal(r.imported, 1)
    assert.equal(r.list[0].id, 'a')
    assert.equal(r.list[0].sql, 'SELECT 1')
  })

  test('导出：脏对象（带凭据字段）落盘仍不含凭据', () => {
    const out = path.join(dir, 'share.json')
    f.exportFavorites([{ id: 'a', sql: 'SELECT 1', password: 'p', token: 't' }], out)
    const raw = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.equal(raw[0].password, undefined)
    assert.equal(raw[0].token, undefined)
  })

  test('损坏/不存在文件读作空数组', () => {
    assert.deepEqual(f.listFavorites(file), [])
    fs.writeFileSync(file, '{broken json')
    assert.deepEqual(f.listFavorites(file), [])
  })

  test('原子写：不留 .tmp 残留', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a' }), file)
    assert.equal(fs.existsSync(file + '.tmp'), false)
    assert.equal(fs.existsSync(file), true)
  })
})
