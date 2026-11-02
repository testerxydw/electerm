// H8a-b 本地文件引擎（SQLite）的路径 / 选择器 / 连接目标口径（src/client/common/db-file.js）
//
// 为什么用 vm 跑 src 下同一份源码（与 db-grid-view.spec.js 同一做法）：源码是 ESM，
// 且**不许出现"测试拷贝"**——对话框过滤器、路径归一、连接目标这三条一旦在实现与
// 测试之间漂移，测试就变成自证，而它们坏掉时用户看到的是"选不到 .sqlite3"
// "保存后连不上""sqlite 页签挂着 127.0.0.1:3306"。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-file.js')
const CONSTANTS = path.join(ROOT, 'src/client/common/constants.js')
const TAB = path.join(ROOT, 'src/client/components/tabs/tab.jsx')
const DB_SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const CONN_ERROR = path.join(ROOT, 'src/client/components/database/db-conn-error.jsx')

const EXPORTS = '({ SQLITE_FILE_EXTS, MEMORY_DB_FILE, dbFileTypes, isDbFileType, ' +
  'sqliteFileDialogOptions, normalizeDbFilePath, dbFilePathLabel, dbConnTarget })'

function loadFrom (file, exportsExpr) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export /gm, '')
  const sandbox = { Set, Array, Object, String, Number, Math, JSON, RegExp, Boolean }
  vm.createContext(sandbox)
  return vm.runInContext(src + '\n' + exportsExpr, sandbox)
}

const read = file => fs.readFileSync(file, 'utf8')

const {
  SQLITE_FILE_EXTS,
  MEMORY_DB_FILE,
  dbFileTypes,
  isDbFileType,
  sqliteFileDialogOptions,
  normalizeDbFilePath,
  dbFilePathLabel,
  dbConnTarget
} = loadFrom(SRC, EXPORTS)

// vm 里造出来的数组属于另一个 realm，strict deepEqual 会连原型一起比；搬回宿主 realm
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

describe('db-file: 库文件扩展名与选择器参数', () => {
  test('扩展名清单（钉死，新增要写进设计文档）', () => {
    assert.deepEqual(plain(SQLITE_FILE_EXTS), ['db', 'sqlite', 'sqlite3', 'db3', 's3db'])
  })

  test('扩展名不带点、不重复', () => {
    for (const ext of SQLITE_FILE_EXTS) {
      assert.ok(!ext.startsWith('.'), `Electron filters 要的是不带点的扩展名: ${ext}`)
    }
    assert.equal(new Set(SQLITE_FILE_EXTS).size, SQLITE_FILE_EXTS.length)
  })

  test('内存库标记', () => {
    assert.equal(MEMORY_DB_FILE, ':memory:')
  })

  test('对话框：单文件 + 允许隐藏文件 + SQLite/全部两道过滤器', () => {
    const opts = sqliteFileDialogOptions('选择库文件')
    assert.equal(opts.title, '选择库文件')
    assert.equal(opts.message, '选择库文件')
    assert.ok(opts.properties.includes('openFile'))
    assert.ok(opts.properties.includes('showHiddenFiles'))
    assert.deepEqual(plain(opts.filters.map(f => f.name)), ['SQLite database', 'All files'])
    assert.deepEqual(plain(opts.filters[0].extensions), plain(SQLITE_FILE_EXTS))
    // 兜底过滤器让用户能选到 mydb.dat 这类非标准名字
    assert.deepEqual(plain(opts.filters[1].extensions), ['*'])
  })
})

describe('db-file: normalizeDbFilePath', () => {
  test('去首尾空白', () => {
    assert.equal(normalizeDbFilePath('  /tmp/a.db  '), '/tmp/a.db')
  })

  test('剥成对引号（用户从终端粘贴常带）', () => {
    assert.equal(normalizeDbFilePath('"/tmp/a b.db"'), '/tmp/a b.db')
    assert.equal(normalizeDbFilePath("'/tmp/a b.db'"), '/tmp/a b.db')
    assert.equal(normalizeDbFilePath(' "/x.db" '), '/x.db')
  })

  test('不成对的引号原样保留（那是文件名的一部分，不是包裹）', () => {
    assert.equal(normalizeDbFilePath('"/tmp/a.db'), '"/tmp/a.db')
    assert.equal(normalizeDbFilePath("'"), "'")
  })

  test('空值一律归成空串', () => {
    for (const v of [null, undefined, '', '   ']) {
      assert.equal(normalizeDbFilePath(v), '')
    }
  })

  test('不做 path.resolve：相对路径交主进程适配器统一处理', () => {
    assert.equal(normalizeDbFilePath('data/app.db'), 'data/app.db')
  })
})

describe('db-file: dbFilePathLabel', () => {
  test('取最后一段，正斜杠与反斜杠都切', () => {
    assert.equal(dbFilePathLabel('/var/lib/app/x.sqlite3'), 'x.sqlite3')
    assert.equal(dbFilePathLabel('C:\\Users\\me\\data.db'), 'data.db')
  })

  test('内存库返回 :memory: 本体（不能被切成 "memory:"）', () => {
    assert.equal(dbFilePathLabel(':memory:'), ':memory:')
  })

  test('空 → 空串；以分隔符结尾（填成目录了）→ 原样返回，不报错', () => {
    assert.equal(dbFilePathLabel(''), '')
    assert.equal(dbFilePathLabel(null), '')
    assert.equal(dbFilePathLabel('/tmp/'), '/tmp/')
  })

  test('先归一再取段（带引号带空格的输入也能显示）', () => {
    assert.equal(dbFilePathLabel(' "/tmp/a.db" '), 'a.db')
  })
})

describe('db-file: 本地文件引擎判定', () => {
  test('引擎集合 = {sqlite}，且与 constants 的 dbTypeMap.sqlite 同名', () => {
    assert.deepEqual([...dbFileTypes], ['sqlite'])
    assert.ok(isDbFileType('sqlite'))
    for (const t of ['mysql', 'redis', 'postgres', 'tidb', 'oceanbase', 'kingbase']) {
      assert.ok(!isDbFileType(t), `${t} 是网络引擎`)
    }
  })

  test('空/非法 dbType 不抛错', () => {
    for (const v of [null, undefined, '', 0, {}]) {
      assert.equal(isDbFileType(v), false)
    }
  })

  test('constants.js 再导出同一份集合（避免两处各写一个字面量）', () => {
    const src = read(CONSTANTS)
    assert.match(src, /export \{ dbFileTypes \} from '\.\/db-file\.js'/)
    assert.ok(
      !/export const dbFileTypes = new Set\(/.test(src),
      'constants.js 不该再自己定义一份 dbFileTypes'
    )
  })
})

describe('db-file: dbConnTarget（连接位置唯一口径）', () => {
  test('网络引擎：host:port', () => {
    assert.equal(dbConnTarget({ dbType: 'mysql', dbHost: '10.0.0.1', dbPort: 3306 }), '10.0.0.1:3306')
    assert.equal(dbConnTarget({ dbType: 'redis', dbHost: 'h', dbPort: 6379 }), 'h:6379')
  })

  test('没有端口时只出 host，不留 "h:" 这种残缺冒号', () => {
    for (const port of [undefined, null, '', 0]) {
      assert.equal(dbConnTarget({ dbType: 'postgres', dbHost: 'h', dbPort: port }), 'h')
    }
  })

  test('本地引擎忽略残留的 host/port（切引擎不清字段，呈现也不能跟着串味）', () => {
    const tab = { dbType: 'sqlite', dbFile: '/data/app.db', dbHost: '127.0.0.1', dbPort: 3306 }
    assert.equal(dbConnTarget(tab), 'app.db')
    assert.equal(dbConnTarget(tab, true), '/data/app.db')
  })

  test('本地引擎：默认短文件名，full 给完整路径', () => {
    const tab = { dbType: 'sqlite', dbFile: '/data/really/long/app.sqlite3' }
    assert.equal(dbConnTarget(tab), 'app.sqlite3')
    assert.equal(dbConnTarget(tab, true), '/data/really/long/app.sqlite3')
    assert.equal(dbConnTarget({ dbType: 'sqlite', dbFile: ':memory:' }), ':memory:')
  })

  test('本地引擎但没填文件 → 空串（调用方自己兜底成标题）', () => {
    assert.equal(dbConnTarget({ dbType: 'sqlite' }), '')
    assert.equal(dbConnTarget({ dbType: 'sqlite', dbFile: '  ' }), '')
  })

  test('网络引擎但没填 host → 空串', () => {
    assert.equal(dbConnTarget({ dbType: 'mysql', dbPort: 3306 }), '')
  })

  test('缺 dbType 按网络引擎处理（sqlite 之外都走 host，宁可不显示也不显示文件名）', () => {
    assert.equal(dbConnTarget({ dbHost: 'h', dbPort: 1234 }), 'h:1234')
  })

  test('空 tab / null 不抛错', () => {
    assert.equal(dbConnTarget(null), '')
    assert.equal(dbConnTarget(undefined), '')
    assert.equal(dbConnTarget({}), '')
  })
})

describe('db-file: 呈现层接线（不允许再各写一份 host:port）', () => {
  test('页签 tooltip / 会话工具条 / 连接错误卡片都走 dbConnTarget', () => {
    assert.match(read(TAB), /dbConnTarget\(tab, true\)/)
    assert.match(read(DB_SESSION), /dbConnTarget\(tab\)/)
    assert.match(read(CONN_ERROR), /dbConnTarget\(tab\)/)
  })

  test('这三处不再手工拼 dbHost:dbPort（历史实现，会显示被忽略的残留地址）', () => {
    for (const file of [TAB, DB_SESSION, CONN_ERROR]) {
      assert.doesNotMatch(
        read(file),
        /tab\.dbHost\s*\?\s*`\$\{tab\.dbHost\}/,
        `${path.basename(file)} 里还在手工拼 host:port`
      )
    }
  })

  test('SQLite 连接失败有专门的排查文案（中英文都要有）', () => {
    const locales = read(path.join(ROOT, 'src/app/common/locales-extra.js'))
    assert.match(read(CONN_ERROR), /'dbErrSqliteFile'/)
    assert.equal((locales.match(/dbErrSqliteFile:/g) || []).length, 2, 'en + zh_cn 各一条')
  })
})
