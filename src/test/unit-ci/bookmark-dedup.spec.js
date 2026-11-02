// 书签查重的判据（纯函数）
//
// 钉的是口径本身：同名 + 同连接 才算重复。只差名字是两种用途（prod/web 与
// dev/web），只差连接是同一台机器的不同入口（两套密钥、两个用户）——都不许拦。
// 另一半是"判不了就不放闸"：本地终端、空标题、字段残缺一律放行，
// 误伤用户手工排好的书签比放走一条重复贵。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/bookmark-dedup.js')

const load = async () => import(pathToFileURL(MOD).href)

const ssh = (o = {}) => ({
  id: o.id, type: 'ssh', title: o.title, host: o.host, port: o.port, username: o.username
})

describe('同名 + 同连接才算重复', () => {
  it('两个条件都成立才算同一条，缺一不可', async () => {
    const { isSameBookmark } = await load()
    const a = ssh({ title: 'web', host: 'h.example.com', port: 22, username: 'root' })
    assert.equal(isSameBookmark(a, ssh({ title: 'web', host: 'h.example.com', port: 22, username: 'root' })), true)
    // 只同名：两台机器同名标签是常事
    assert.equal(isSameBookmark(a, ssh({ title: 'web', host: 'other.example.com', port: 22, username: 'root' })), false)
    // 只同连接：同一台机器换个用途起名，不该被当成重复
    assert.equal(isSameBookmark(a, ssh({ title: 'web-只读', host: 'h.example.com', port: 22, username: 'root' })), false)
    assert.equal(isSameBookmark(a, ssh({ title: 'web', host: 'h.example.com', port: 2222, username: 'root' })), false)
    assert.equal(isSameBookmark(a, ssh({ title: 'web', host: 'h.example.com', port: 22, username: 'deploy' })), false)
  })

  it('标题与主机/用户的大小写、首尾空白都不算差别', async () => {
    const { isSameBookmark } = await load()
    const a = ssh({ title: 'Web Server', host: 'HOSTA', username: 'Root', port: 22 })
    const b = ssh({ title: ' web server ', host: 'hosta ', username: 'root', port: 22 })
    assert.equal(isSameBookmark(a, b), true)
  })

  it('ssh 端口缺省按 22、用户缺省按 root 补（写了 22 的和留空的是同一个入口）', async () => {
    const { bookmarkConnKey, isSameBookmark } = await load()
    assert.equal(bookmarkConnKey(ssh({ host: 'h', username: 'root' })), bookmarkConnKey(ssh({ host: 'h', port: 22, username: 'root' })))
    assert.equal(bookmarkConnKey(ssh({ host: 'h', port: 22 })), bookmarkConnKey(ssh({ host: 'h', port: 22, username: 'root' })))
    assert.equal(isSameBookmark(
      ssh({ title: 't', host: 'h', port: 22, username: 'root' }),
      ssh({ title: 't', host: 'h', username: 'root' })
    ), true)
  })

  it('telnet/ftp/rdp/vnc 各按自己的默认端口补齐', async () => {
    const { bookmarkConnKey } = await load()
    const eq = (a, b) => assert.equal(bookmarkConnKey(a), bookmarkConnKey(b))
    eq({ type: 'telnet', title: 't', host: 'h' }, { type: 'telnet', title: 't', host: 'h', port: 23 })
    eq({ type: 'ftp', title: 't', host: 'h' }, { type: 'ftp', title: 't', host: 'h', port: 21 })
    eq({ type: 'rdp', title: 't', host: 'h' }, { type: 'rdp', title: 't', host: 'h', port: 3389 })
    eq({ type: 'vnc', title: 't', host: 'h' }, { type: 'vnc', title: 't', host: 'h', port: 5900 })
    assert.notEqual(bookmarkConnKey({ type: 'telnet', host: 'h', port: 23 }),
      bookmarkConnKey({ type: 'ftp', host: 'h', port: 21 }))
  })

  it('serial 认串口与波特率，web 认 URL', async () => {
    const { isSameBookmark } = await load()
    const s = (path, baudRate) => ({ type: 'serial', title: 'dev', path, baudRate })
    assert.equal(isSameBookmark(s('/dev/ttyUSB0', 9600), s('/dev/ttyUSB0', 9600)), true)
    assert.equal(isSameBookmark(s('/dev/ttyUSB0', 9600), s('/dev/ttyUSB0', 115200)), false)
    assert.equal(isSameBookmark(s('/dev/ttyUSB0', 9600), s('/dev/ttyUSB1', 9600)), false)
    const w = url => ({ type: 'web', title: 'dash', url })
    assert.equal(isSameBookmark(w('https://a.example.com'), w(' HTTPS://A.EXAMPLE.COM ')), true)
    assert.equal(isSameBookmark(w('https://a.example.com'), w('https://b.example.com')), false)
  })
})

describe('判不了就放行', () => {
  it('本地终端没有"连接"这回事，建十个也不叫重复', async () => {
    const { bookmarkConnKey, isSameBookmark } = await load()
    const a = { type: 'local', title: '本地' }
    assert.equal(bookmarkConnKey(a), '')
    assert.equal(isSameBookmark(a, { type: 'local', title: '本地' }), false)
  })

  it('没起名的书签不拦（用户还在填，撞不上）', async () => {
    const { isSameBookmark, findDuplicateBookmarks } = await load()
    const a = ssh({ title: '', host: 'h', port: 22, username: 'root' })
    assert.equal(isSameBookmark(a, ssh({ title: '', host: 'h', port: 22, username: 'root' })), false)
    assert.equal(findDuplicateBookmarks(a, [ssh({ id: 1, title: '', host: 'h', port: 22, username: 'root' })]).length, 0)
  })

  it('定位字段空着（半成品/来路不明的导入）一律放行', async () => {
    const { bookmarkConnKey, isSameBookmark } = await load()
    assert.equal(bookmarkConnKey(ssh({ title: 't', host: '', port: 22, username: 'root' })), '')
    assert.equal(bookmarkConnKey({ type: 'serial', title: 't', baudRate: 9600 }), '')
    assert.equal(bookmarkConnKey({ type: 'web', title: 't' }), '')
    assert.equal(isSameBookmark(
      ssh({ title: 't', host: '', port: 22, username: 'root' }),
      ssh({ title: 't', host: '', port: 22, username: 'root' })
    ), false)
  })

  it('用户名/端口空着不算"没定位"：telnet 本来就常没有用户', async () => {
    const { bookmarkConnKey, isSameBookmark } = await load()
    const t = { type: 'telnet', title: 't', host: 'h' }
    assert.notEqual(bookmarkConnKey(t), '')
    assert.equal(isSameBookmark(t, { type: 'telnet', title: 't', host: 'h', port: 23 }), true)
  })

  it('认不出的类型不产键，也不抛', async () => {
    const { bookmarkConnKey } = await load()
    assert.equal(bookmarkConnKey({ type: 'some-new-thing', title: 't', host: 'h' }), '')
    for (const bad of [undefined, null, '', 0, [], {}]) {
      assert.equal(typeof bookmarkConnKey(bad), 'string', JSON.stringify(bad))
    }
  })

  it('旧数据不带 type 就按 ssh 算（与 constants/visibility 同口径）', async () => {
    const { bookmarkConnKey } = await load()
    assert.equal(
      bookmarkConnKey({ title: 't', host: 'h', port: 22, username: 'root' }),
      bookmarkConnKey(ssh({ title: 't', host: 'h', port: 22, username: 'root' }))
    )
  })
})

describe('数据库书签的连接键', () => {
  const db = (o = {}) => ({ type: 'database', title: 'db', ...o })

  it('引擎/主机/端口/用户/库名任一不同就是两条连接', async () => {
    const { isSameBookmark } = await load()
    const base = { dbType: 'mysql', dbHost: 'h', dbPort: 3306, dbUser: 'root', dbName: 'app' }
    assert.equal(isSameBookmark(db(base), db(base)), true)
    for (const patch of [
      { dbType: 'postgres' }, { dbHost: 'other' }, { dbPort: 5432 },
      { dbUser: 'app' }, { dbName: 'other' }
    ]) {
      assert.equal(isSameBookmark(db(base), db({ ...base, ...patch })), false, JSON.stringify(patch))
    }
  })

  it('本地文件走 dbFile：两个不同文件不许并成一条', async () => {
    const { isSameBookmark } = await load()
    assert.equal(isSameBookmark(db({ dbType: 'sqlite', dbFile: '/a/x.db' }), db({ dbType: 'sqlite', dbFile: '/a/x.db' })), true)
    assert.equal(isSameBookmark(db({ dbType: 'sqlite', dbFile: '/a/x.db' }), db({ dbType: 'sqlite', dbFile: '/b/y.db' })), false)
    // 同一引擎：一个是文件、一个是远端，本来就不是同一条连接
    assert.equal(isSameBookmark(db({ dbType: 'sqlite', dbFile: '/a/x.db' }), db({ dbType: 'sqlite' })), false)
  })

  it('既没填主机也没填文件 → 判不了，放行', async () => {
    const { bookmarkConnKey } = await load()
    assert.equal(bookmarkConnKey(db({ dbType: 'mysql' })), '')
  })
})

describe('新建与改名时的查询', () => {
  const list = [
    ssh({ id: 'a', title: 'web', host: 'h', port: 22, username: 'root' }),
    ssh({ id: 'b', title: 'web', host: 'h', port: 22, username: 'root' }),
    ssh({ id: 'c', title: 'db', host: 'h', port: 22, username: 'root' })
  ]

  it('命中已有那几条，顺序跟原列表', async () => {
    const { findDuplicateBookmarks, hasDuplicateBookmark } = await load()
    const hits = findDuplicateBookmarks(ssh({ title: 'WEB', host: ' H ', port: 22, username: 'root' }), list)
    assert.deepEqual(hits.map(d => d.id), ['a', 'b'])
    assert.equal(hasDuplicateBookmark(ssh({ title: 'web', host: 'h', port: 22, username: 'root' }), list), true)
  })

  it('改名校验排除自己：把自己改回原来的名字不算重复', async () => {
    const { findDuplicateBookmarks } = await load()
    const self = ssh({ id: 'a', title: 'web', host: 'h', port: 22, username: 'root' })
    // 不带 selfId：库里 a、b 两条都命中（a 就是自己）
    assert.deepEqual(findDuplicateBookmarks(self, list).map(d => d.id), ['a', 'b'])
    // 带 selfId：只剩 b —— 那才是真正要拦的另一条
    assert.deepEqual(findDuplicateBookmarks(self, list, 'a').map(d => d.id), ['b'])
    // 把 a 改名成 c 已经有的名字，才是该拦的那次编辑
    assert.deepEqual(findDuplicateBookmarks(
      ssh({ id: 'a', title: 'db', host: 'h', port: 22, username: 'root' }), list, 'a'
    ).map(d => d.id), ['c'])
  })

  it('id 类型不一致也算同一条（历史数据里 id 可能是数字）', async () => {
    const { findDuplicateBookmarks } = await load()
    const withNum = [ssh({ id: 7, title: 'web', host: 'h', port: 22, username: 'root' })]
    assert.deepEqual(findDuplicateBookmarks(ssh({ title: 'web', host: 'h', port: 22, username: 'root' }), withNum, '7'), [])
  })

  it('库里一条都没有 / 传进来的就是残缺对象：不抛、返回空', async () => {
    const { findDuplicateBookmarks, hasDuplicateBookmark } = await load()
    assert.deepEqual(findDuplicateBookmarks(undefined, undefined), [])
    assert.deepEqual(findDuplicateBookmarks(ssh({ title: 't', host: 'h', port: 22 }), null), [])
    assert.equal(hasDuplicateBookmark(ssh({ title: 't' }), list), false)
  })
})

describe('存量重复清单', () => {
  const mk = (id, title, host) => ssh({ id, title, host, port: 22, username: 'root' })

  it('只留 2 条以上的堆，组内按原顺序（第一条就是最早那条）', async () => {
    const { groupDuplicateBookmarks } = await load()
    const list = [mk('1', 'web', 'h'), mk('2', 'solo', 'x'), mk('3', 'web', 'h'), mk('4', 'web', 'o')]
    const groups = groupDuplicateBookmarks(list)
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].items.map(d => d.id), ['1', '3'])
    assert.equal(groups[0].title, 'web')
  })

  it('多出来的条数才是清理量（3 条一堆要删 2 条）', async () => {
    const { countDuplicateBookmarks } = await load()
    const list = [mk('1', 'web', 'h'), mk('2', 'web', 'h'), mk('3', 'web', 'h'), mk('4', 'solo', 'x')]
    assert.equal(countDuplicateBookmarks(list), 2)
    assert.equal(countDuplicateBookmarks([mk('1', 'a', 'h'), mk('2', 'b', 'h')]), 0)
  })

  it('按堆大小从刺眼的开始排，同大小按名字', async () => {
    const { groupDuplicateBookmarks } = await load()
    const list = [
      mk('1', 'zzz', 'h'), mk('2', 'zzz', 'h'),
      mk('3', 'aaa', 'h'), mk('4', 'aaa', 'h'), mk('5', 'aaa', 'h')
    ]
    const groups = groupDuplicateBookmarks(list)
    assert.deepEqual(groups.map(g => g.title), ['aaa', 'zzz'])
  })

  it('同名不同机、同机不同名都不进清单', async () => {
    const { groupDuplicateBookmarks } = await load()
    const list = [
      mk('1', 'web', 'h1'), mk('2', 'web', 'h2'),
      mk('3', 'a', 'h1'), mk('4', 'b', 'h1')
    ]
    assert.deepEqual(groupDuplicateBookmarks(list), [])
  })

  it('清单里给出能说给人听的目标（不是内部键）', async () => {
    const { groupDuplicateBookmarks, describeBookmarkTarget } = await load()
    const groups = groupDuplicateBookmarks([mk('1', 'web', 'h'), mk('2', 'web', 'h')])
    assert.equal(groups[0].target, 'root@h:22')
    assert.equal(describeBookmarkTarget({ type: 'database', dbType: 'mysql', dbHost: 'db', dbPort: 3306, dbUser: 'app' }), 'app@db:3306')
    assert.equal(describeBookmarkTarget({ type: 'database', dbType: 'sqlite', dbFile: '/a/x.db' }), 'sqlite:///a/x.db')
    assert.equal(describeBookmarkTarget({ type: 'serial', path: '/dev/ttyUSB0', baudRate: 9600 }), '/dev/ttyUSB0')
    assert.equal(describeBookmarkTarget(undefined), '')
  })
})

describe('批量导入默认跳过', () => {
  const mk = (id, title, host) => ssh({ id, title, host, port: 22, username: 'root' })

  it('已有同名同连接的不进列表，且原样交回调用方去报数', async () => {
    const { pickNewBookmarks } = await load()
    const existing = [mk('1', 'web', 'h')]
    const incoming = [mk('a', 'web', 'h'), mk('b', 'web', 'other'), mk('c', 'web', 'h')]
    const { fresh, skipped } = pickNewBookmarks(incoming, existing)
    assert.deepEqual(fresh.map(d => d.id), ['b'])
    assert.deepEqual(skipped.map(d => d.id), ['a', 'c'])
    // 不许就地改对象：界面拿的还是同一份引用，改了会连着 store 一起变
    assert.equal(skipped[0], incoming[0])
  })

  it('同一批里自我重复只留第一条', async () => {
    const { pickNewBookmarks } = await load()
    const incoming = [mk('a', 'web', 'h'), mk('b', 'web', 'h')]
    const { fresh, skipped } = pickNewBookmarks(incoming, [])
    assert.deepEqual(fresh.map(d => d.id), ['a'])
    assert.deepEqual(skipped.map(d => d.id), ['b'])
  })

  it('空列表不抛；判不了的残缺条目照常放行（不静默丢掉别人的书签）', async () => {
    const { pickNewBookmarks } = await load()
    assert.deepEqual(pickNewBookmarks(undefined, undefined), { fresh: [], skipped: [] })
    const { fresh, skipped } = pickNewBookmarks([{}, null, mk('a', 'web', 'h')], [])
    assert.equal(fresh.length, 3)
    assert.deepEqual(skipped, [])
  })
})
