// P-3 历史行连接状态点（2026-11-04 拍板"只做连接状态点，纯视觉，不动数据模型"）
//
// 状态点不落在任何持久化数据里，是每次渲染从 store.tabs 现算的一张表，
// 所以钉的是这张表的口径：
// 1) 同一目标多个页签 → 只有一颗，取"最能说明它开着"的那条（已连上 > 正在连 > 连不上）；
// 2) 只有会亮的三个状态参与，default/warning 不算"开着"；
// 3) 判不了连接键的行（本地终端、字段残缺）一律不画点 —— 宁可不画，
//    也不把"说不清"画成"没连"；
// 4) 历史条目和页签走同一把键（bookmarkConnKey），端口缺省/ssh 空用户名这种
//    "写法不同、指向同一台"必须能对上，否则功能等于没有。
// 末尾是源码契约：状态名与 constants.js 的 statusMap 同源、点只在有状态时画、
// 槽位常驻、颜色只吃 token 且与页签条 .tab-status 同一映射。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/history-conn-status.js')
const DEDUP = path.join(ROOT, 'src/client/common/bookmark-dedup.js')
const CONSTANTS = path.join(ROOT, 'src/client/common/constants.js')
const HISTORY_JSX = path.join(ROOT, 'src/client/components/sidebar/history.jsx')
const HISTORY_ITEM_JSX = path.join(ROOT, 'src/client/components/sidebar/history-item.jsx')
const LIST_STYL = path.join(ROOT, 'src/client/components/setting-panel/list.styl')
const TABS_STYL = path.join(ROOT, 'src/client/components/tabs/tabs.styl')

const load = async () => import(pathToFileURL(MOD).href)

const ssh = (o = {}) => ({
  type: 'ssh',
  title: o.title,
  host: o.host,
  port: o.port,
  username: o.username,
  status: o.status
})

const db = (o = {}) => ({
  type: 'database',
  title: o.title,
  dbType: o.dbType,
  dbHost: o.dbHost,
  dbPort: o.dbPort,
  dbUser: o.dbUser,
  dbName: o.dbName,
  dbFile: o.dbFile,
  status: o.status
})

describe('openStatusByConn：连接键 → 当前最亮的状态', () => {
  it('同一目标多个页签只留一颗，优先级 已连上 > 正在连 > 连不上', async () => {
    const { openStatusByConn, historyConnStatus } = await load()
    const a = ssh({ host: 'h1', port: 22, username: 'root', status: 'error' })
    const b = ssh({ host: 'h1', port: 22, username: 'root', status: 'processing' })
    const c = ssh({ host: 'h1', port: 22, username: 'root', status: 'success' })
    // 乱序喂进去：先好后坏、先坏后好都取 success
    for (const tabs of [[a, b, c], [c, b, a], [b, a, c]]) {
      const map = openStatusByConn(tabs)
      assert.equal(map.size, 1, '同一把连接键只有一条')
      assert.equal(historyConnStatus(a, map), 'success')
    }
    const map = openStatusByConn([a, b])
    assert.equal(historyConnStatus(a, map), 'processing', '没有已连上时取正在连')
    assert.equal(historyConnStatus(a, openStatusByConn([a])), 'error', '只剩连不上时才是错误')
  })

  it('default / warning / 空状态不参与，不参与的目标不进表', async () => {
    const { openStatusByConn, historyConnStatus } = await load()
    const map = openStatusByConn([
      ssh({ host: 'h-default', port: 22, username: 'root', status: 'default' }),
      ssh({ host: 'h-warning', port: 22, username: 'root', status: 'warning' }),
      ssh({ host: 'h-none', port: 22, username: 'root' })
    ])
    assert.equal(map.size, 0, '没开会的目标不该有点')
    assert.equal(historyConnStatus(ssh({ host: 'h-default', port: 22, username: 'root' }), map), '')
  })

  it('同一 host 的不同入口是不同目标（端口/用户/引擎库名各自分键）', async () => {
    const { openStatusByConn, historyConnStatus } = await load()
    const base = { host: 'h1', username: 'root', status: 'success' }
    const map = openStatusByConn([
      ssh({ ...base, port: 22 }),
      ssh({ ...base, port: 2222 }),
      ssh({ host: 'h1', port: 22, username: 'deploy', status: 'processing' })
    ])
    assert.equal(map.size, 3, '端口与用户名都参与定位')
    assert.equal(historyConnStatus(ssh({ ...base, port: 22 }), map), 'success')
    assert.equal(historyConnStatus(ssh({ ...base, port: 2222 }), map), 'success')
    assert.equal(historyConnStatus(ssh({ host: 'h1', port: 22, username: 'deploy' }), map), 'processing')
  })

  it('写法不同、指向同一台要能对上：端口缺省按协议补、ssh 空用户名按 root', async () => {
    const { openStatusByConn, historyConnStatus } = await load()
    const map = openStatusByConn([ssh({ host: 'H1', port: 22, username: 'root', status: 'success' })])
    // 历史快照常见形态：端口留空、用户名留空（表单默认值就是空 = root）
    assert.equal(historyConnStatus(ssh({ host: 'h1', port: '', username: '', status: 'default' }), map), 'success')
    assert.equal(historyConnStatus(ssh({ host: ' h1 ', port: undefined, username: undefined }), map), 'success')
  })

  it('database 走单独一把键：引擎/host/port/user/db 定位，本地文件按 dbFile', async () => {
    const { openStatusByConn, historyConnStatus } = await load()
    const mysql57 = db({ dbType: 'mysql', dbHost: 'db.example.com', dbPort: 3306, dbUser: 'app', dbName: 'shop', status: 'success' })
    const pg = db({ dbType: 'postgresql', dbHost: 'db.example.com', dbPort: 3306, dbUser: 'app', dbName: 'shop', status: 'processing' })
    const otherDb = db({ dbType: 'mysql', dbHost: 'db.example.com', dbPort: 3306, dbUser: 'app', dbName: 'report', status: 'error' })
    const sqliteA = db({ dbType: 'sqlite', dbFile: '/data/a.db', status: 'success' })
    const sqliteB = db({ dbType: 'sqlite', dbFile: '/data/b.db', status: 'error' })
    const map = openStatusByConn([mysql57, pg, otherDb, sqliteA, sqliteB])
    assert.equal(map.size, 5, '引擎/库名/文件任一处不同就是不同目标')
    assert.equal(historyConnStatus(db({ dbType: 'mysql', dbHost: 'db.example.com', dbPort: 3306, dbUser: 'app', dbName: 'shop' }), map), 'success')
    assert.equal(historyConnStatus(db({ dbType: 'postgresql', dbHost: 'db.example.com', dbPort: 3306, dbUser: 'app', dbName: 'shop' }), map), 'processing')
    assert.equal(historyConnStatus(db({ dbType: 'mysql', dbHost: 'db.example.com', dbPort: 3306, dbUser: 'app', dbName: 'report' }), map), 'error')
    assert.equal(historyConnStatus(db({ dbType: 'sqlite', dbFile: '/data/B.DB' }), map), 'error')
  })

  it('判不了连接键的页签不进表：本地终端、字段残缺、空/脏入参', async () => {
    const { openStatusByConn } = await load()
    assert.equal(openStatusByConn([
      { type: 'local', title: '本地终端', host: 'ignored', status: 'success' },
      { type: 'ssh', host: '', status: 'success' },
      { type: 'web', url: '', status: 'processing' },
      { type: 'database', dbType: 'mysql', status: 'error' },
      null,
      undefined
    ]).size, 0, '全都不产键 → 空表')
    assert.equal(openStatusByConn(undefined).size, 0)
    assert.equal(openStatusByConn([]).size, 0)
  })
})

describe('historyConnStatus：查不到就什么也不画', () => {
  it('没有表 / 没有条目 / 表里没这条 → 空串', async () => {
    const { openStatusByConn, historyConnStatus } = await load()
    const item = ssh({ host: 'h1', port: 22, username: 'root' })
    const map = openStatusByConn([ssh({ host: 'h2', port: 22, username: 'root', status: 'success' })])
    assert.equal(historyConnStatus(item, undefined), '')
    assert.equal(historyConnStatus(item, null), '')
    assert.equal(historyConnStatus(item, new Map()), '')
    assert.equal(historyConnStatus(item, map), '', '另一台机器开着，这一行不该亮')
    assert.equal(historyConnStatus(undefined, map), '')
    assert.equal(historyConnStatus({ host: 'h1' }, openStatusByConn([item])), '', '缺 host 判不了 → 不画')
  })
})

describe('与既有口径同源', () => {
  it('连接键就是查重那把键（同一台机器的判定只有一份）', async () => {
    const { bookmarkConnKey } = await import(pathToFileURL(DEDUP).href)
    const { openStatusByConn, historyConnStatus } = await load()
    const tab = ssh({ host: 'h1', port: 22, username: 'root', status: 'success' })
    const map = openStatusByConn([tab])
    // 表里的键必须能在查重模块里原样复现，而不是本模块自己再算一套
    assert.deepEqual([...map.keys()], [bookmarkConnKey(tab)])
    assert.equal(historyConnStatus(tab, map), 'success')
  })

  it('会亮的三个状态名仍然是 constants.js statusMap 里的那三个', () => {
    // 本模块不 import constants（那个模块带 .png，node 侧 import 不了），
    // 状态名是抄过来的 —— 这里钉住"抄的还一致"：改名/删名红的是这条。
    const src = fs.readFileSync(CONSTANTS, 'utf8')
    const block = /export const statusMap = buildConst\(\[([\s\S]*?)\]\)/.exec(src)
    assert.ok(block, 'constants.js 里 statusMap 的定义形态变了，同步改这条守卫')
    const names = block[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    const mod = fs.readFileSync(MOD, 'utf8')
    const litBlock = /const LIT = \{([\s\S]*?)\n\}/.exec(mod)
    assert.ok(litBlock, 'history-conn-status.js 里 LIT 的定义形态变了')
    const lit = [...litBlock[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1])
    assert.deepEqual(lit, ['success', 'processing', 'error'], '点亮顺序：已连上 > 正在连 > 连不上')
    for (const name of lit) {
      assert.ok(names.includes(name), `statusMap 里已没有 ${name}：本页签状态点会静默失效`)
    }
  })
})

describe('接线契约', () => {
  it('历史面板每次渲染从 store.tabs 现算一张表，并把状态传给行', () => {
    const src = fs.readFileSync(HISTORY_JSX, 'utf8')
    assert.ok(/openStatusByConn\(store\.tabs\)/.test(src), '状态表来自 store.tabs，每次渲染现算')
    assert.match(src, /connStatus=\{historyConnStatus\(item\.tab, openStatus\)\}/)
    // 纯视觉：不许往 history 条目里写状态字段（数据模型不动是拍板的前提）
    assert.ok(!/item\.status\s*=/.test(src), '不给 history 条目加字段')
  })

  it('行：槽位常驻（有点没点首文字不错位），点只在有状态时画，class 带状态名', () => {
    const src = fs.readFileSync(HISTORY_ITEM_JSX, 'utf8')
    const slot = src.indexOf('history-status-slot')
    const dot = src.indexOf('history-status-dot')
    assert.ok(slot !== -1 && dot !== -1)
    assert.ok(slot < dot, '槽位在外、点在内')
    assert.match(src, /connStatus\s*\n?\s*\?\s*\(/, '无状态时不画点（而不是画一颗灰点占位）')
    assert.match(src, /className=\{'history-status-dot ' \+ connStatus\}/)
    assert.match(src, /aria-hidden='true'/, '纯视觉，读屏不念')
    assert.ok(!/title=\{/.test(src.slice(slot, dot)), '槽位不带 tooltip（与页签条 .tab-status 一致，且避开词条文件）')
  })

  it('样式：7px 与页签条同口径，三个状态的颜色映射一致，只用 token', () => {
    const styl = fs.readFileSync(LIST_STYL, 'utf8')
    const block = /\.history-status-dot\n((?:[ \t].*\n)*)/.exec(styl)
    assert.ok(block, 'list.styl 里 .history-status-dot 的定义形态变了')
    const body = block[1]
    assert.match(body, /width 7px/, '尺寸跟页签条 .tab-status')
    assert.match(body, /height 7px/)
    assert.match(body, /border-radius var\(--radius[a-z-]*\)/, '圆角只吃 token')
    for (const [cls, token] of [['success', '--success'], ['processing', '--primary'], ['error', '--error']]) {
      assert.match(
        styl,
        new RegExp(`&\\.${cls}\\n\\s*background-color var\\(${token}\\)`),
        `.${cls} 应该是 ${token}（与 .tab-status 同一映射）`
      )
    }
    // 页签条那三行是映射的权威，这里核对它没被改走
    const tabBlock = /\.tab-status\n((?:[ \t].*\n)*)/.exec(fs.readFileSync(TABS_STYL, 'utf8'))
    assert.ok(tabBlock, 'tabs.styl 里 .tab-status 的定义形态变了')
    for (const [cls, token] of [['success', '--success'], ['processing', '--primary'], ['error', '--error']]) {
      assert.ok(
        new RegExp(`&\\.${cls}[\\s\\S]{0,200}?background-color var\\(${token}\\)`).test(tabBlock[1]),
        `.tab-status.${cls} 用的不是 ${token}：两处状态点颜色会分家`
      )
    }
    // 不加动效：这一列一次排十几行，呼吸/光晕会让"哪条开着"反而看不出来
    assert.ok(!/animation/.test(body), '.history-status-dot 不做呼吸动效')
    assert.ok(!/box-shadow/.test(body), '.history-status-dot 不加光晕')
    // 槽位常驻宽度：有点没点首文字不错位
    const slotBlock = /\.history-status-slot\n((?:[ \t].*\n)*)/.exec(styl)
    assert.ok(slotBlock, 'list.styl 里 .history-status-slot 的定义形态变了')
    assert.match(slotBlock[1], /width \d+px/, '槽位定宽')
    assert.match(slotBlock[1], /flex 0 0 auto/, '槽位不参与伸缩')
  })
})
