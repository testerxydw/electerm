const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const EDITOR = path.join(ROOT, 'src/client/components/database/db-sql-editor.jsx')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

let f

const load = async () => {
  f = f || await import('../../../src/client/common/sql-file.js')
}

describe('H6c 查询文件：路径与脏标记的纯计算', () => {
  it('取文件名：兼容 / 与 \\ 分隔，无目录时原样', async () => {
    await load()
    assert.equal(f.sqlFileBaseName('/home/u/q/orders.sql'), 'orders.sql')
    assert.equal(f.sqlFileBaseName('C:\\work\\q\\orders.sql'), 'orders.sql')
    assert.equal(f.sqlFileBaseName('orders.sql'), 'orders.sql')
    assert.equal(f.sqlFileBaseName(''), '')
    assert.equal(f.sqlFileBaseName(null), '')
    // 末尾没有文件名的目录路径不编造名字
    assert.equal(f.sqlFileBaseName('/tmp/'), '')
  })

  it('脏标记按原文比较：只有真改动才算脏', async () => {
    await load()
    assert.equal(f.isSqlFileDirty('SELECT 1', 'SELECT 1'), false)
    assert.equal(f.isSqlFileDirty('SELECT 1\n', 'SELECT 1'), true)
    assert.equal(f.isSqlFileDirty('SELECT 1 ', 'SELECT 1'), true)
    // null/undefined 与空串等价：刚打开空文件不该一上来就脏
    assert.equal(f.isSqlFileDirty(null, ''), false)
    assert.equal(f.isSqlFileDirty('', undefined), false)
  })

  it('页签文案：无文件仍是 SQL，有文件名显示文件名，脏了补 •', async () => {
    await load()
    assert.equal(f.sqlFileTabLabel('', false), 'SQL')
    assert.equal(f.sqlFileTabLabel(null, true), 'SQL')
    assert.equal(f.sqlFileTabLabel('/tmp/orders.sql', false), 'orders.sql')
    assert.equal(f.sqlFileTabLabel('/tmp/orders.sql', true), 'orders.sql •')
    // 带空格文件名也要能显示
    assert.equal(f.sqlFileTabLabel('/tmp/my query.sql', false), 'my query.sql')
  })

  it('打开对话框只要 .sql + 全部文件，且能选单个文件', async () => {
    await load()
    const opts = f.sqlOpenDialogOptions()
    assert.ok(opts.properties.includes('openFile'))
    assert.equal(opts.properties.includes('openDirectory'), false)
    assert.deepEqual(opts.filters[0], { name: 'SQL', extensions: ['sql'] })
    assert.equal(opts.filters[1].extensions[0], '*')
  })

  it('保存对话框默认名：有路径用文件名，无路径给 query.sql', async () => {
    await load()
    assert.equal(f.sqlSaveDialogOptions('/x/a.sql').defaultPath, 'a.sql')
    assert.equal(f.sqlSaveDialogOptions('').defaultPath, 'query.sql')
    assert.ok(f.sqlSaveDialogOptions('/x/a.sql').properties.includes('showOverwriteConfirmation'))
  })

  it('补扩展名：没有扩展名才补，已有任意扩展名不动', async () => {
    await load()
    assert.equal(f.withSqlExt('/tmp/q'), '/tmp/q.sql')
    assert.equal(f.withSqlExt('/tmp/q.sql'), '/tmp/q.sql')
    assert.equal(f.withSqlExt('/tmp/q.SQL'), '/tmp/q.SQL')
    assert.equal(f.withSqlExt('/tmp/v1.2/q'), '/tmp/v1.2/q.sql')
    assert.equal(f.withSqlExt(''), '')
  })
})

describe('H6c 接线契约（真实源码抽取）', () => {
  // N11b-#28：sqlFile / 脏标记 / 打开 / 保存已迁到 use-db-sql-file.js，
  // 组合读取源拼上该 hook（否则这几条契约读到 air）
  const SQL_FILE_HOOK = path.join(ROOT, 'src/client/components/database/use-db-sql-file.js')
  const sessionSrc = () => fs.readFileSync(SESSION, 'utf8') + '\n' + fs.readFileSync(SQL_FILE_HOOK, 'utf8')
  const editorSrc = () => fs.readFileSync(EDITOR, 'utf8')
  const locales = () => fs.readFileSync(LOCALES, 'utf8')

  it('会话层真的接了打开/保存与脏标记（不是只在纯函数里自转）', () => {
    const src = sessionSrc()
    assert.match(src, /from '\.\.\/\.\.\/common\/sql-file'/)
    assert.match(src, /const \[sqlFile, setSqlFile\] = useState\(null\)/)
    assert.match(src, /const sqlFileDirty = !!sqlFile && isSqlFileDirty\(/)
    // 读走 ws fs（utf8），写走 fs.writeFile；对话框走 preload 的 window.api
    assert.match(src, /await fs\.readFile\(filePath\)/)
    assert.match(src, /await fs\.writeFile\(filePath, sqlText\)/)
    assert.match(src, /window\.api\.openDialog\(sqlOpenDialogOptions\(\)\)/)
    assert.match(src, /window\.api\.saveDialog\(sqlSaveDialogOptions\(''\)\)/)
    // 保存后 savedText 跟上，脏标记才能消失
    assert.match(src, /setSqlFile\(\{ path: filePath, savedText: sqlText \}\)/)
  })

  it('工具栏两个入口 + 页签文件名 + 完整路径 title', () => {
    const src = sessionSrc()
    assert.match(src, /title=\{e\('dbSqlFileOpen'\)\}[\s\S]{0,80}onClick=\{openSqlFile\}/)
    assert.match(src, /title=\{e\('dbSqlFileSave'\)\}[\s\S]{0,80}onClick=\{saveSqlFile\}/)
    assert.match(src, /sqlFileTabLabel\(sqlFile && sqlFile\.path, sqlFileDirty\)/)
    assert.match(src, /title=\{sqlFile && sqlFile\.path \? sqlFile\.path : undefined\}/)
    // 脏时保存按钮高亮，与页签的 • 同一信号
    assert.match(src, /type=\{sqlFileDirty \? 'primary' : 'default'\}/)
  })

  it('编辑器接 Mod-s 保存（且没把默认返回 true 时的空回调吞掉）', () => {
    const src = editorSrc()
    assert.match(src, /key: 'Mod-s'/)
    assert.match(src, /cbRef\.current\.onSave/)
    // 父组件把保存回调接到编辑器上
    assert.match(sessionSrc(), /onSave=\{saveSqlFile\}/)
    // 没有回调时返回 false，让键位继续冒泡而不是假装处理了
    assert.match(src, /if \(!fn\) \{\s*return false\s*\}/)
  })

  it('关闭守卫同时覆盖事务与未保存文件，且先事务后文件', () => {
    const src = sessionSrc()
    assert.match(src, /!txSupported && !sqlFileDirty/)
    const guard = src.slice(src.indexOf('guards[tabId] = async () =>'))
    const txAt = guard.indexOf("e('dbTxCloseTitle')")
    const fileAt = guard.indexOf("e('dbSqlFileCloseTitle')")
    assert.ok(txAt > 0, '事务确认还在')
    assert.ok(fileAt > txAt, '文件确认要排在事务确认之后')
    assert.match(guard, /e\('dbSqlFileCloseWarn'\)\.replace\('\{file\}', sqlFileBaseName\(sqlFile && sqlFile\.path\)\)/)
  })

  it('两种语言的词条都在，且占位符一致', () => {
    const src = locales()
    for (const key of [
      'dbSqlFileOpen', 'dbSqlFileSave', 'dbSqlFileOpened', 'dbSqlFileSaved',
      'dbSqlFileReadErr', 'dbSqlFileWriteErr', 'dbSqlFileReplaceTitle',
      'dbSqlFileReplaceWarn', 'dbSqlFileReplaceOk', 'dbSqlFileCloseTitle',
      'dbSqlFileCloseWarn', 'dbSqlFileDiscard'
    ]) {
      assert.equal((src.match(new RegExp('\\b' + key + ':', 'g')) || []).length, 2, key + ' 应中英各一条')
    }
    assert.equal((src.match(/dbSqlFileOpened: '[^']*\{file\}[^']*'/g) || []).length, 2)
    assert.equal((src.match(/dbSqlFileCloseWarn: '[^']*\{file\}[^']*'/g) || []).length, 2)
  })
})
