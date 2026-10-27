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
    const { list } = f.saveFavorite(entry('SELECT 1'), file)
    assert.equal(list.length, 1)
    assert.ok(list[0].id.startsWith('fav-'))
    const { list: list2 } = f.saveFavorite(entry('SELECT 2'), file)
    assert.equal(list2.length, 2)
    assert.equal(list2[0].sql, 'SELECT 2')
    // 跨调用（跨启动）可读
    assert.equal(f.listFavorites(file).length, 2)
  })

  test('upsert：带已存在 id 保存即覆盖，不追加', () => {
    const { list: l1 } = f.saveFavorite(entry('SELECT 1', { id: 'fav-a' }), file)
    assert.equal(l1[0].id, 'fav-a')
    const { list: l2 } = f.saveFavorite(entry('SELECT 9', { id: 'fav-a', title: 'renamed' }), file)
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
    // group 字段缺省时 pickEntry 不落盘（undefined 键被 JSON 丢弃），故白名单为原有五键
    assert.deepEqual(Object.keys(item).sort(), ['dbType', 'id', 'sql', 'title', 'ts'])
  })

  test('空语句保存是 no-op', () => {
    const { list } = f.saveFavorite({ title: 'x', sql: '' }, file)
    assert.equal(list.length, 0)
    const { list: l2 } = f.saveFavorite(null, file)
    assert.equal(l2.length, 0)
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

  test('内容去重：新建时归一化 SQL 命中旧条目 → 合并不重复插入', () => {
    const { list: l1 } = f.saveFavorite(entry('SELECT  *  FROM  t\nWHERE id=1'), file)
    assert.equal(l1.length, 1)
    const firstId = l1[0].id
    // 空白/大小写差异归一后视为同一条，返回 duplicate 且合并标题
    const { list: l2, duplicate } = f.saveFavorite(
      { id: '', title: 'rename', sql: 'select * from t where id=1' },
      file
    )
    assert.equal(l2.length, 1)
    assert.ok(duplicate)
    assert.equal(l2[0].id, firstId) // 保留原 id
    assert.equal(l2[0].title, 'rename') // 标题被刷新
  })

  test('内容去重：带 id 保存不走去重（显式覆盖）', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a' }), file)
    const { list, duplicate } = f.saveFavorite({ id: 'a', title: 't', sql: 'SELECT 1' }, file)
    assert.equal(list.length, 1)
    assert.equal(duplicate, null)
  })

  test('分组：group 字段落盘与读取', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a', group: '备份' }), file)
    const item = f.listFavorites(file)[0]
    assert.equal(item.group, '备份')
  })

  test('listGroups：统计各分组条数（默认分组归并到空串）', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a', group: '备份' }), file)
    f.saveFavorite(entry('SELECT 2', { id: 'b', group: '备份' }), file)
    f.saveFavorite(entry('SELECT 3', { id: 'c' }), file)
    const g = f.listGroups(file)
    assert.equal(g['备份'], 2)
    assert.equal(g[''], 1)
  })

  test('renameGroup：改写组名并落盘；旧组不存在原样返回', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a', group: '旧组' }), file)
    const l1 = f.renameGroup('旧组', '新组', file)
    assert.equal(l1.find(x => x.id === 'a').group, '新组')
    assert.equal(f.listFavorites(file)[0].group, '新组')
    const l2 = f.renameGroup('不存在', 'X', file)
    assert.equal(l2.find(x => x.id === 'a').group, '新组')
  })

  test('deleteGroup：组内条目移回默认分组，不删收藏', () => {
    f.saveFavorite(entry('SELECT 1', { id: 'a', group: '临时' }), file)
    const l = f.deleteGroup('临时', file)
    assert.equal(l.length, 1)
    assert.equal(l[0].group, '')
    assert.equal(l[0].sql, 'SELECT 1')
  })

  test('filterByGroups：空/缺省返回全部，否则按组筛选', () => {
    const items = [
      { id: 'a', sql: '1', group: 'g1' },
      { id: 'b', sql: '2', group: 'g2' },
      { id: 'c', sql: '3', group: '' }
    ]
    assert.equal(f.filterByGroups(items, []).length, 3)
    assert.equal(f.filterByGroups(items, ['g1']).length, 1)
    assert.equal(f.filterByGroups(items, ['g1', 'g2']).length, 2)
    assert.equal(f.filterByGroups(items, ['']).length, 1)
  })

  test('normSql/hashSql：空白与大小写归一，同语句哈希一致', () => {
    assert.equal(f.normSql('SELECT  *\nFROM t'), 'select * from t')
    assert.equal(f.hashSql('SELECT 1'), f.hashSql('  select   1  '))
  })

  // ---- 空分组登记（修复"新建分组后看不到"）----
  test('createGroup：登记空分组并持久化；重名幂等', () => {
    const gfile = path.join(dir, 'db-sql-fav-groups.json')
    f.createGroup('报表', gfile)
    f.createGroup('报表', gfile)
    assert.deepEqual(f.createGroup(' 分析 ', gfile), ['报表', '分析'])
    // 跨调用（跨启动）可读
    assert.deepEqual(JSON.parse(fs.readFileSync(gfile, 'utf8')), ['报表', '分析'])
  })

  test('listGroups：合并登记的空分组（计 0），有条目后由推导覆盖', () => {
    const gfile = path.join(dir, 'db-sql-fav-groups.json')
    f.createGroup('空组', gfile)
    f.saveFavorite(entry('SELECT 1', { id: 'a', group: '实组' }), file)
    let g = f.listGroups(file, gfile)
    assert.equal(g['空组'], 0)
    assert.equal(g['实组'], 1)
    // 组内出现条目后仍是同一分组名，计数切换为推导值
    f.saveFavorite(entry('SELECT 2', { id: 'b', group: '空组' }), file)
    g = f.listGroups(file, gfile)
    assert.equal(g['空组'], 1)
  })

  test('listGroups：不传 groupsPath 保持旧行为（纯推导）', () => {
    const gfile = path.join(dir, 'db-sql-fav-groups.json')
    f.createGroup('孤组', gfile)
    const g = f.listGroups(file)
    assert.ok(!('孤组' in g))
  })

  test('renameGroup：空分组登记表同步改名', () => {
    const gfile = path.join(dir, 'db-sql-fav-groups.json')
    f.createGroup('旧名', gfile)
    f.renameGroup('旧名', '新名', file, gfile)
    const names = JSON.parse(fs.readFileSync(gfile, 'utf8'))
    assert.ok(names.includes('新名'))
    assert.ok(!names.includes('旧名'))
  })

  test('deleteGroup：空分组登记表同步移除', () => {
    const gfile = path.join(dir, 'db-sql-fav-groups.json')
    f.createGroup('将删', gfile)
    f.deleteGroup('将删', file, gfile)
    const names = JSON.parse(fs.readFileSync(gfile, 'utf8'))
    assert.ok(!names.includes('将删'))
  })
})
