// 导入本地 ssh 配置的去重判据（纯函数 + store 接线契约）
//
// 钉的是"点一次导入复制一份"这个真机问题：同一次导入内部重复、跨次导入重复、
// 历史数据没有来源标记，三种都得挡住；同时手工建的书签一律不许被自动合并。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/ssh-config-import.js')
const STORE = 'src/client/store/bookmark.js'
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const load = async () => import(pathToFileURL(MOD).href)

const item = (host, port, username) => ({ type: 'ssh', host, port, username })

describe('同一条目的键', () => {
  it('host/user 大小写与空白不影响，port 缺省按 22', async () => {
    const { sshConfigKey } = await load()
    assert.equal(sshConfigKey(item('HostA', 22, 'Root')), sshConfigKey(item(' hosta ', '22', 'root')))
    assert.equal(sshConfigKey(item('h', undefined, 'u')), sshConfigKey(item('h', '', 'u')))
    assert.equal(sshConfigKey(item('h', 22, 'u')), sshConfigKey(item('h', 22, 'u')))
  })

  it('端口或用户不同就是两个入口，不许并掉', async () => {
    const { sshConfigKey } = await load()
    assert.notEqual(sshConfigKey(item('h', 22, 'root')), sshConfigKey(item('h', 2222, 'root')))
    assert.notEqual(sshConfigKey(item('h', 22, 'root')), sshConfigKey(item('h', 22, 'deploy')))
  })

  it('残缺输入不抛（界面上能手改 JSON，host 可能就没有）', async () => {
    const { sshConfigKey } = await load()
    assert.equal(typeof sshConfigKey(undefined), 'string')
    assert.equal(typeof sshConfigKey(null), 'string')
    assert.equal(typeof sshConfigKey({}), 'string')
  })
})

describe('导入去重', () => {
  it('同一次导入里的重复块只留第一条，顺序不变', async () => {
    const { pickNewSshConfigItems } = await load()
    const items = [item('a', 22, 'root'), item('b', 22, 'root'), item('A', 22, 'ROOT')]
    const got = pickNewSshConfigItems(items, [], null)
    assert.deepEqual(got.map(d => d.host), ['a', 'b'])
  })

  it('已经导入过的不再新建（第二次点导入是幂等的）', async () => {
    const { pickNewSshConfigItems, sourceField, sshConfigSource } = await load()
    const imported = [
      { id: 'x1', [sourceField]: sshConfigSource, host: 'a', port: 22, username: 'root' }
    ]
    const got = pickNewSshConfigItems([item('a', 22, 'root'), item('c', 22, 'root')], imported, null)
    assert.deepEqual(got.map(d => d.host), ['c'])
  })

  it('历史数据没有来源标记：挂在 sshConfig 分组里的书签也算已导入', async () => {
    const { pickNewSshConfigItems } = await load()
    const bookmarks = [{ id: 'old1', host: 'a', port: 22, username: 'root' }]
    const group = { id: 'sshConfig', bookmarkIds: ['old1'] }
    assert.deepEqual(pickNewSshConfigItems(bookmarks, bookmarks, group), [])
    assert.deepEqual(pickNewSshConfigItems(bookmarks, bookmarks, null).map(d => d.host), ['a'],
      '没有分组信息时不该假装已导入（否则手工建的会被吞掉）')
  })

  it('手工建的同主机书签不挡导入（去重只管 ssh 配置这条路）', async () => {
    const { pickNewSshConfigItems } = await load()
    const manual = [{ id: 'm1', host: 'a', port: 22, username: 'root' }]
    const got = pickNewSshConfigItems([item('a', 22, 'root')], manual, { bookmarkIds: [] })
    assert.deepEqual(got.map(d => d.host), ['a'])
  })

  it('删掉导入的书签后能再导入回来（分组里的悬空 id 不算已存在）', async () => {
    const { pickNewSshConfigItems, sshConfigKey } = await load()
    const group = { id: 'sshConfig', bookmarkIds: ['gone'] }
    const got = pickNewSshConfigItems([item('a', 22, 'root')], [], group)
    assert.deepEqual(got.map(d => sshConfigKey(d)), [sshConfigKey(item('a', 22, 'root'))])
  })

  it('空列表 / 缺参数只回空，不抛', async () => {
    const { pickNewSshConfigItems } = await load()
    assert.deepEqual(pickNewSshConfigItems(undefined, undefined, undefined), [])
    assert.deepEqual(pickNewSshConfigItems([], [], { bookmarkIds: [] }), [])
  })
})

describe('分组书签列表', () => {
  it('新导入的在前，重复 id 只留第一次出现', async () => {
    const { mergeBookmarkIds } = await load()
    assert.deepEqual(mergeBookmarkIds(['n1', 'n2'], ['n2', 'o1']), ['n1', 'n2', 'o1'])
  })

  it('id 原样保留（不改类型），空参数不抛', async () => {
    const { mergeBookmarkIds } = await load()
    assert.deepEqual(mergeBookmarkIds([1, '1'], undefined), [1])
    assert.deepEqual(mergeBookmarkIds(null, null), [])
  })
})

describe('store 接线契约', () => {
  it('addSshConfigs 走纯函数判据，且给新书签打上来源标记', async () => {
    const { sourceField, sshConfigSource, sshConfigGroupId } = await load()
    const src = read(STORE)
    const fn = src.match(/addSshConfigs = function[\s\S]*?\n {2}\}/)
    assert.ok(fn, 'addSshConfigs 找不到了，判据要先跟着改')
    assert.match(fn[0], /pickNewSshConfigItems\(/, '去重必须交给纯函数，才有条单测钉得住')
    assert.match(fn[0], /mergeBookmarkIds\(/, '分组列表不许再裸拼（裸拼就是重复的来源）')
    assert.match(fn[0], /\[sourceField\]:\s*sshConfigSource/,
      '新书签要带来源标记，且字段名/值都取自纯模块的导出')
    // 字面量只许待在纯模块里：store 写死一份，改了模块这边不会报错，只会静默失配
    assert.equal(fn[0].includes("'" + sourceField + "'"), false, '字段名不许在 store 里写死')
    assert.equal(fn[0].includes("'" + sshConfigGroupId + "'"), false, '分组 id 也不许写死字面量')
    assert.ok(src.includes(sshConfigGroupId), '分组 id 用模块导出的常量')
    assert.equal(sshConfigGroupId, 'sshConfig', '分组 id 是历史数据里的值，改了等于把老用户的导入落点弄丢')
    assert.equal(sshConfigSource, 'sshConfig')
  })

  it('一条都没新增时给一句话，不让用户对着没变化的列表猜', () => {
    const src = read(STORE)
    assert.match(src, /message\.info\(e\('sshConfigNothingNew'\)\)/)
    const extra = require(path.join(ROOT, 'src/app/common/locales-extra'))
    assert.ok(extra.en.sshConfigNothingNew, 'en 词条缺失')
    assert.ok(extra.zh_cn.sshConfigNothingNew, 'zh_cn 词条缺失')
  })
})
