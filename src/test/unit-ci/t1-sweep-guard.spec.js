const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')
const SHELL = path.join(SRC, 'client/components/common/session-shell.jsx')
const SHELL_OLD = path.join(SRC, 'client/components/common/remote-session-shell.jsx')
const ON_CLOSE = path.join(SRC, 'app/lib/on-close.js')
const DB_SESSION = path.join(SRC, 'client/components/database/db-session.jsx')
// N11a：两处空态内联渲染已接线成独立 shipped 组件，正向 i18n 契约组合读取全部发布源码。
const DB_REDIS_KEY_SPACE = path.join(SRC, 'client/components/database/db-redis-key-space.jsx')
const DB_TREE_PANEL = path.join(SRC, 'client/components/database/db-tree-panel.jsx')
const SCHEMAS = path.join(SRC, 'client/common/bookmark-schemas.js')
const SYNC = path.join(SRC, 'client/store/sync.js')
const SHORTCUT = path.join(SRC, 'client/components/shortcuts/shortcut-control.jsx')

// T1 清扫批（2026-10-20）六项回归守护，配套
// doc/已完成/审计-全项目七维度审计-2026-10-21.md（附：2026-10-20 复核）：
//   S0 改名 / P2-15 await / P2-13 i18n / P2-14 database schema /
//   关键字同步 A / shortcut 监听清理
// 每项含正向断言 + 反向验证（防回退、防漂移）

const readSrc = p => fs.readFileSync(path.join(SRC, p), 'utf8')

// 递归收集文本源文件（限定源码扩展名，跳过产物/依赖/测试目录）
function walkSources (dir, exts = ['.js', '.jsx', '.styl'], acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'work' || name === 'dist' || name === 'test') {
      continue
    }
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      walkSources(p, exts, acc)
    } else if (exts.includes(path.extname(name))) {
      acc.push(p)
    }
  }
  return acc
}

describe('T1 sweep: S0 SessionShell rename', () => {
  test('old names fully removed from src (no stale reference)', () => {
    for (const f of walkSources(SRC)) {
      const src = fs.readFileSync(f, 'utf8')
      assert.ok(
        !src.includes('RemoteSessionShell') && !src.includes('remote-session-shell'),
        'stale old name in ' + f
      )
    }
  })

  test('old files gone, new files export SessionShell', () => {
    assert.equal(fs.existsSync(SHELL_OLD), false, 'old jsx must be renamed away')
    assert.equal(
      fs.existsSync(SHELL_OLD.replace(/\.jsx$/, '.styl')), false,
      'old styl must be renamed away'
    )
    const src = fs.readFileSync(SHELL, 'utf8')
    assert.ok(src.includes('export default class SessionShell'), 'export name')
    assert.ok(src.includes("import './session-shell.styl'"), 'styl import follows rename')
  })

  test('rdp/vnc/spice all import the new shell', () => {
    for (const page of ['rdp/rdp-session.jsx', 'vnc/vnc-session.jsx', 'spice/spice-session.jsx']) {
      const src = readSrc('client/components/' + page)
      assert.ok(
        src.includes("import SessionShell from '../common/session-shell'"),
        page + ' must import SessionShell'
      )
      assert.ok(
        src.includes('<SessionShell') && src.includes('</SessionShell>'),
        page + ' must render SessionShell'
      )
    }
  })
})

describe('T1 sweep: P2-15 on-close awaits db cleanup', () => {
  test('closeAllDbTabs is awaited (reverse: no fire-and-forget call)', () => {
    const src = fs.readFileSync(ON_CLOSE, 'utf8')
    const calls = src.split('\n').filter(l => l.includes('closeAllDbTabs'))
    assert.ok(calls.length > 0, 'closeAllDbTabs call must exist')
    for (const line of calls) {
      assert.ok(
        /await\s+.*closeAllDbTabs/.test(line),
        'every closeAllDbTabs call must be awaited, got: ' + line.trim()
      )
    }
  })
})

describe('T1 sweep: P2-13 empty-state copy i18n', () => {
  test('empty states go through translate', () => {
    const src = fs.readFileSync(DB_SESSION, 'utf8') + '\n' +
      fs.readFileSync(DB_REDIS_KEY_SPACE, 'utf8') + '\n' + fs.readFileSync(DB_TREE_PANEL, 'utf8')
    assert.ok(src.includes("e('dbSelectDb')"), 'redis empty state i18n')
    assert.ok(src.includes("e('dbNoMetadata')"), 'tree empty state i18n')
  })

  test('reverse: no hardcoded english description props', () => {
    const src = fs.readFileSync(DB_SESSION, 'utf8')
    assert.ok(!src.includes("description='select a db node'"), 'hardcoded redis empty copy')
    assert.ok(!src.includes("description='no metadata'"), 'hardcoded tree empty copy')
  })
})

describe('T1 sweep: P2-14 database bookmark schema', () => {
  // ESM 严格解析不吃无扩展名相对导入（'./zod'），
  // 源码内替换为绝对 file URL 后经 data: URL 加载（无临时文件）
  const loadSchemas = async () => {
    const zodUrl = pathToFileURL(path.join(SRC, 'client/common/zod.js')).href
    let src = fs.readFileSync(SCHEMAS, 'utf8')
    src = src.replace(/from '\.\/zod'/, "from '" + zodUrl + "'")
    assert.ok(!src.includes("from './zod'"), 'zod import rewritten')
    return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  }

  const loadZod = () => import(pathToFileURL(path.join(SRC, 'client/common/zod.js')).href)

  test('database type present, original 9 types intact', async () => {
    const { bookmarkSchemas } = await loadSchemas()
    const keys = Object.keys(bookmarkSchemas)
    for (const k of ['ssh', 'telnet', 'serial', 'vnc', 'rdp', 'ftp', 'web', 'local', 'spice', 'database']) {
      assert.ok(keys.includes(k), 'schema type ' + k + ' must exist')
    }
  })

  test('database schema fields align with form config/database.js', async () => {
    const { databaseBookmarkSchema } = await loadSchemas()
    // 书签层只有 title 必填。"哪个引擎要 host、哪个引擎要库文件"是**条件**关系，
    // 落在表单配置里（showWhen + rules），schema 里钉不成死清单——
    // 本条从前把 dbHost 与 5 个引擎写死在断言里，H8a 加 SQLite（无 host、改要 dbFile）
    // 时没同步这里，于是它红了一次：写死的对表清单就是这种漂移的制造机。
    assert.equal(databaseBookmarkSchema.title._optional, false, 'title must be required')
    for (const f of ['dbType', 'dbHost', 'dbPort', 'dbUser', 'dbPassword', 'dbName', 'dbFile',
      'sshTunnelBookmarkId', 'readOnly', 'color', 'description']) {
      assert.ok(databaseBookmarkSchema[f], 'field ' + f + ' must exist')
      assert.equal(databaseBookmarkSchema[f]._optional, true, f + ' must stay optional at schema level')
    }
    // dbType 枚举与 constants.js 的 dbTypeMap 取自同一份来源（新增引擎不必再来改这里）
    const constsSrc = readSrc('client/common/constants.js')
    const mapBody = /export const dbTypeMap = buildConst\(\[([\s\S]*?)\]\)/.exec(constsSrc)
    assert.ok(mapBody, 'dbTypeMap parsed from constants.js')
    const engines = [...mapBody[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    assert.ok(engines.length >= 5, 'dbTypeMap non-trivial, got ' + engines.length)
    assert.deepEqual(databaseBookmarkSchema.dbType._meta.values, engines)
    // 条件必填真的挂在表单上：网络引擎才要 host，本地文件引擎才要 dbFile
    const formSrc = readSrc('client/components/bookmark-form/config/database.js')
    const fieldBlock = name => {
      const at = formSrc.indexOf("name: '" + name + "'")
      assert.ok(at >= 0, 'form field ' + name + ' present')
      // 字段对象切到"下一个同缩进的字段起点"为止：配置里既有单行字段（dbHost）
      // 也有跨行字段（dbFile），只取一行的话后者读不到 showWhen/required
      const rest = formSrc.slice(at)
      const end = rest.search(/\n {8}\{/)
      return end < 0 ? rest.slice(0, 600) : rest.slice(0, end)
    }
    for (const [name, when] of [['dbHost', 'showWhenNet'], ['dbFile', 'showWhenFile']]) {
      const block = fieldBlock(name)
      assert.match(block, new RegExp('showWhen: ' + when), name + ' gated by engine kind')
      assert.match(block, /required: true/, name + ' required when shown')
    }
    // 可见性判定只认一个来源：文件引擎集合（新增本地引擎只改那一处）
    assert.match(formSrc, /const isNet = dbType => !dbFileTypes\.has\(dbType\)/)
  })

  test('agent-tools real path: z.toJSONSchema(z.object(schema)) works', async () => {
    const mod = await loadSchemas()
    const { z } = await loadZod()
    const json = z.toJSONSchema(z.object(mod.bookmarkSchemas.database))
    assert.ok(json.properties && json.properties.dbHost, 'json schema has dbHost')
    assert.ok(json.properties.dbType, 'json schema has dbType')
  })
})

describe('T1 sweep: keywords joins config sync whitelist', () => {
  test('configSyncKeys contains keywords (reverse: dbPageSize must not regress)', () => {
    const src = fs.readFileSync(SYNC, 'utf8')
    const m = src.match(/const configSyncKeys = \[([\s\S]*?)\]/)
    assert.ok(m, 'configSyncKeys array found')
    const keys = m[1].match(/'([^']+)'/g) || []
    assert.ok(keys.includes("'keywords'"), 'keywords must sync')
    assert.ok(keys.includes("'dbPageSize'"), 'dbPageSize must keep syncing')
  })
})

describe('T1 sweep: shortcut document listeners cleanup', () => {
  const load = () => fs.readFileSync(SHORTCUT, 'utf8')

  test('componentWillUnmount removes the 3 document listeners', () => {
    const src = load()
    const m = src.match(/componentWillUnmount \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(m, 'componentWillUnmount exists')
    for (const ev of ["'keydown'", "'mousedown'", "'mousewheel'"]) {
      assert.ok(m[0].includes('removeEventListener(' + ev), 'removes ' + ev)
    }
  })

  test('every addEventListener has a matching remove (event, target, capture)', () => {
    const src = load()
    const rx = /(add|remove)EventListener\(([^)]+)\)/g
    const adds = []
    const removes = []
    let m
    while ((m = rx.exec(src))) {
      const args = m[2].split(',').map(s => s.trim())
      ;(m[1] === 'add' ? adds : removes).push(args.join('|'))
    }
    assert.equal(adds.length, 3, '3 listeners added')
    assert.equal(removes.length, 3, '3 listeners removed')
    for (const a of adds) {
      assert.ok(removes.includes(a), 'remove matches add args: ' + a)
    }
    // keydown 挂载带 capture=true，移除必须同参（反向：无参 remove 会漏移除）
    assert.ok(
      adds.some(a => a.includes("'keydown'") && a.endsWith('true')),
      'keydown capture=true'
    )
  })

  test('reverse: no local bind copy handed to addEventListener (reference drift)', () => {
    const src = load()
    const cdm = src.match(/componentDidMount \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(cdm, 'componentDidMount exists')
    // 历史坑：const onEvent = bind 后挂 document，卸载拿不到同一引用
    const body = cdm[0].replace(/\n/g, ' ')
    assert.ok(
      !/\bconst \w+ = [\w.]+\.bind\(this\)/.test(body),
      'bind copy must be stored on this, not a local const'
    )
    assert.ok(src.includes('this.boundKeyboardEvent'), 'bind copy stored on instance')
  })
})
