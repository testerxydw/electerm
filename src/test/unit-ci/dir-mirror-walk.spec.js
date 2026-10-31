// G5-2：目录镜像的采集层（两端拉平成一棵树的条目列表）
//
// 判据的重心在"缺一块就别放行"：条目截断、深度截断、单目录读失败、用户取消
// 都必须让 complete=false（界面靠它决定能不能勾"删除远端多余项"）；
// 以及两个适配器把本地 mtimeMs / 远端秒级 modifyTime 归一到同一个毫秒口径，
// 归一错了就是"整棵树看起来都变了"。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const WALK = path.join(__dirname, '../../client/common/dir-mirror-walk.js')
const MIRROR = path.join(__dirname, '../../client/common/dir-mirror.js')

let walk
let mirror
const load = async () => {
  if (!walk) {
    walk = await import(pathToFileURL(WALK).href)
    mirror = await import(pathToFileURL(MIRROR).href)
  }
  return walk
}

const lf = (name, size, mtimeMs) => ({
  name,
  size,
  mtimeMs,
  isDirectory: false,
  isSymbolicLink: false
})
const ld = (name, mtimeMs = 1_730_000_000_000) => ({
  name,
  size: 4096,
  mtimeMs,
  isDirectory: true,
  isSymbolicLink: false
})

// 一棵树写成 { 相对根的路径: [条目] }，键 '' 表示根
const treeReader = (tree, root = '/root') => async (abs) => {
  const key = abs.startsWith(root) ? abs.slice(root.length) : abs
  const hit = tree[key]
  if (!hit) {
    throw new Error('no such dir: ' + abs)
  }
  return hit
}

describe('G5 采集 - 本地条目归一', () => {
  test('readdirStatAsync 的字段照搬成中间形状', async () => {
    const m = await load()
    const r = m.localEntryToNode({
      name: 'a.txt', size: 12, mtimeMs: 111, isDirectory: false, isSymbolicLink: false
    })
    assert.deepEqual(r, {
      name: 'a.txt', size: 12, mtimeMs: 111, isDirectory: false, isSymbolicLink: false
    })
  })

  test('字段缺失补 0/false，不留下 undefined（差异层只认数）', async () => {
    const m = await load()
    const r = m.localEntryToNode({ name: 'x' })
    assert.equal(r.size, 0)
    assert.equal(r.mtimeMs, 0)
    assert.equal(r.isDirectory, false)
    assert.equal(r.isSymbolicLink, false)
  })

  test('负数大小当没有', async () => {
    const m = await load()
    assert.equal(m.localEntryToNode({ name: 'x', size: -1 }).size, 0)
  })
})

describe('G5 采集 - 远端条目归一', () => {
  test("type 'd' 是目录、'l' 是链接、'-' 是文件", async () => {
    const m = await load()
    assert.equal(m.remoteEntryToNode({ name: 'a', type: 'd' }).isDirectory, true)
    assert.equal(m.remoteEntryToNode({ name: 'a', type: 'l' }).isSymbolicLink, true)
    const f = m.remoteEntryToNode({ name: 'a', type: '-' })
    assert.equal(f.isDirectory, false)
    assert.equal(f.isSymbolicLink, false)
  })

  test('modifyTime 已是毫秒就原样用（session-sftp 归一过的路径）', async () => {
    const m = await load()
    const r = m.remoteEntryToNode({ name: 'a', type: '-', modifyTime: 1_730_000_000_000 })
    assert.equal(r.mtimeMs, 1_730_000_000_000)
  })

  test('只有秒级时间戳时乘回毫秒（否则整棵树看起来都"变了"）', async () => {
    const m = await load()
    const r = m.remoteEntryToNode({ name: 'a', type: '-', modifyTime: 1_730_000_000 })
    assert.equal(r.mtimeMs, 1_730_000_000_000)
  })

  test('mtimeMs 兜底 + 0/坏值都算"没有时间戳"', async () => {
    const m = await load()
    assert.equal(m.remoteEntryToNode({ name: 'a', mtimeMs: 1_730_000_000_000 }).mtimeMs, 1_730_000_000_000)
    assert.equal(m.remoteEntryToNode({ name: 'a', modifyTime: 0 }).mtimeMs, 0)
    assert.equal(m.remoteEntryToNode({ name: 'a', modifyTime: 'abc' }).mtimeMs, 0)
  })

  test('isSymbol（sftp-entry 的字段名）也认', async () => {
    const m = await load()
    assert.equal(m.remoteEntryToNode({ name: 'a', isSymbol: true }).isSymbolicLink, true)
  })
})

describe('G5 采集 - 遍历', () => {
  test('只读根目录时得到根下各项，根自己不进列表', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': [lf('a', 1, 1000), ld('b')] }),
      maxDepth: 0
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['a', 'b'])
    assert.equal(r.dirs, 1)
  })

  test('嵌套条目的 relPath 用 / 拼接（跟平台分隔符无关）', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({
        '': [ld('x')],
        '/x': [ld('y')],
        '/x/y': [lf('f', 3, 3000)]
      })
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['x', 'x/y', 'x/y/f'])
  })

  test('读子目录时把拼好的绝对路径交给 readDir（本地用 sep、远端用 /）', async () => {
    const m = await load()
    const calls = []
    await m.walkTree({
      root: '/root',
      readDir: async (abs) => {
        calls.push(abs)
        return abs === '/root' ? [ld('a')] : [lf('f', 1, 1)]
      }
    })
    assert.deepEqual(calls, ['/root', '/root/a'])
  })

  test('joinPath 可换（Windows 本地树用 \\，relPath 仍是 /）', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: 'C:\\root',
      readDir: treeReader({ '': [ld('a')], '\\a': [lf('f', 1, 1)] }, 'C:\\root'),
      joinPath: (base, name) => base + '\\' + name
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['a', 'a/f'])
    assert.equal(r.complete, true)
  })

  test('同一目录里服务端返回的顺序不影响遍历顺序（按名字排）', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': [lf('z', 1, 1), lf('a', 1, 1), ld('m'), lf('c', 1, 1)] })
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['a', 'c', 'm', 'z'])
  })

  test('`.`/`..`/空名/条目不是对象都不进树（否则 relPath 会出现空段）', async () => {
    const m = await load()
    const junk = [{ name: '.' }, { name: '..' }, { name: '' }, null, undefined, lf('ok', 1, 1)]
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': junk })
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['ok'])
  })

  test('全程干净 → complete=true 且没有任何原因', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': [ld('a'), lf('b', 2, 2)], '/a': [lf('c', 3, 3)] })
    })
    assert.equal(r.complete, true)
    assert.deepEqual(r.partialReasons, [])
    assert.deepEqual(r.errors, [])
  })
})

describe('G5 采集 - 缺一块就不放行', () => {
  test('条目上限：命中即停、truncated 与原因都在、complete=false', async () => {
    const m = await load()
    const many = Array.from({ length: 100 }, (_, i) => lf('f' + i, i, i))
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': many }),
      maxEntries: 10
    })
    assert.equal(r.entries.length, 10)
    assert.equal(r.truncated, true)
    assert.deepEqual(r.partialReasons, ['max-entries'])
    assert.equal(r.complete, false)
  })

  test('深度上限：目录本身仍进树（该建它），但不再往下读', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({
        '': [ld('a')],
        '/a': [ld('b')],
        '/a/b': [lf('deep', 1, 1)]
      }),
      maxDepth: 1
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['a', 'a/b'])
    assert.equal(r.depthCut, 1)
    assert.deepEqual(r.partialReasons, ['max-depth'])
    assert.equal(r.complete, false)
  })

  test('取消：停在下一个目录之前，已收到的条目保留', async () => {
    const m = await load()
    let n = 0
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': [ld('a'), ld('b')], '/a': [lf('x', 1, 1)], '/b': [lf('y', 1, 1)] }),
      isCancelled: () => ++n > 1
    })
    assert.equal(r.cancelled, true)
    assert.deepEqual(r.partialReasons, ['cancelled'])
    assert.equal(r.complete, false)
    assert.ok(r.entries.length >= 2)
  })

  test('单个目录读失败不带走整棵树，失败记在它那一条上', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': [ld('a'), ld('b')], '/b': [lf('ok', 1, 1)] })
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['a', 'b', 'b/ok'])
    assert.equal(r.errors.length, 1)
    assert.equal(r.errors[0].relPath, 'a')
    assert.match(r.errors[0].message, /no such dir/)
    assert.deepEqual(r.partialReasons, ['read-error'])
    assert.equal(r.complete, false)
  })

  test('readDir 返回非数组（协议怪值）算读失败，不当成空目录', async () => {
    const m = await load()
    const r = await m.walkTree({ root: '/root', readDir: async () => null })
    assert.equal(r.entries.length, 0)
    assert.match(r.errors[0].message, /not a directory/)
    assert.equal(r.complete, false)
  })

  test('根目录读不了 → 空树但不是"树是空的"，原因要说清', async () => {
    const m = await load()
    const r = await m.walkTree({ root: '/root', readDir: () => { throw new Error('EACCES') } })
    assert.deepEqual(r.entries, [])
    assert.equal(r.errors[0].relPath, '')
    assert.equal(r.complete, false)
  })

  test('错误消息超长截断（断连时能塞进整段栈）', async () => {
    const m = await load()
    const long = 'x'.repeat(5000)
    const r = await m.walkTree({ root: '/root', readDir: () => { throw new Error(long) } })
    assert.ok(r.errors[0].message.length < 300)
    assert.ok(r.errors[0].message.endsWith('…'))
  })

  test('readDir 缺失 / root 缺失：返回同一形状的空树，不抛', async () => {
    const m = await load()
    const a = await m.walkTree({ readDir: undefined, root: '/r' })
    const b = await m.walkTree({ readDir: async () => [], root: '' })
    assert.equal(a.complete, false)
    assert.match(a.errors[0].message, /readDir/)
    assert.equal(b.complete, false)
    assert.match(b.errors[0].message, /root/)
  })
})

describe('G5 采集 - 符号链接', () => {
  test('链接不进树也不跟随（跟进去可能绕成环，也会把树外内容算进来）', async () => {
    const m = await load()
    const r = await m.walkTree({
      root: '/root',
      readDir: treeReader({
        '': [
          { name: 'link', size: 0, mtimeMs: 1, isDirectory: true, isSymbolicLink: true },
          { name: 'flink', size: 7, mtimeMs: 1, isDirectory: false, isSymbolicLink: true },
          lf('real', 1, 1)
        ]
      })
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['real'])
    assert.equal(r.symlinks, 2)
    assert.equal(r.dirs, 1)
    assert.equal(r.complete, true)
  })
})

describe('G5 采集 - 进度与包装', () => {
  test('onProgress 每个目录回调一次，带累计条目数', async () => {
    const m = await load()
    const seen = []
    await m.walkTree({
      root: '/root',
      readDir: treeReader({ '': [ld('a'), lf('b', 1, 1)], '/a': [lf('c', 1, 1)] }),
      onProgress: p => seen.push(p)
    })
    assert.equal(seen.length, 2)
    assert.equal(seen[0].dirs, 1)
    assert.equal(seen[1].entries, 3)
    assert.equal(seen[1].partial, false)
  })

  test('walkLocalTree 用注入的 fs.readdirStatAsync 并过本地适配器', async () => {
    const m = await load()
    const r = await m.walkLocalTree({
      root: '/root',
      fs: {
        readdirStatAsync: async () => [
          { name: 'a.txt', size: 5, mtimeMs: 1_730_000_000_000, isDirectory: false, isSymbolicLink: false }
        ]
      }
    })
    assert.deepEqual(r.entries, [{
      relPath: 'a.txt', name: 'a.txt', size: 5, mtimeMs: 1_730_000_000_000, isDirectory: false
    }])
    assert.equal(r.complete, true)
  })

  test('本地 fs 不可用（web 端 / 旧后端）→ 空树 + 一句人话，不抛', async () => {
    const m = await load()
    const r = await m.walkLocalTree({ root: '/root', fs: {} })
    assert.equal(r.complete, false)
    assert.match(r.errors[0].message, /local fs listing unavailable/)
    const g = await m.walkLocalTree({ root: '/root', fs: undefined })
    assert.equal(g.complete, false)
  })

  test('walkRemoteTree 用 sftp.list 并过远端适配器', async () => {
    const m = await load()
    const r = await m.walkRemoteTree({
      root: '/srv',
      sftp: {
        list: async (p) => p === '/srv'
          ? [{ name: 'logs', type: 'd', size: 4096, modifyTime: 1_730_000_000_000 }]
          : [{ name: 'a.log', type: '-', size: 8, modifyTime: 1_730_000_000_000 }]
      }
    })
    assert.deepEqual(r.entries.map(e => e.relPath), ['logs', 'logs/a.log'])
    assert.equal(r.complete, true)
  })

  test('没有 sftp 客户端（未连上）→ 空树 + 原因', async () => {
    const m = await load()
    const r = await m.walkRemoteTree({ root: '/srv', sftp: null })
    assert.equal(r.complete, false)
    assert.match(r.errors[0].message, /sftp client unavailable/)
  })

  test('walkNote：完整时给空串，取消优先于其它原因', async () => {
    const m = await load()
    assert.equal(m.walkNote({ complete: true, partialReasons: [] }), '')
    assert.equal(m.walkNote({ complete: false, partialReasons: ['max-entries', 'cancelled'] }), 'cancelled')
    assert.equal(m.walkNote({ complete: false, partialReasons: ['max-entries', 'read-error'] }), 'max-entries')
    assert.equal(m.walkNote({ complete: false, partialReasons: ['read-error'] }), 'read-error')
    assert.equal(m.walkNote(null), '')
  })
})

describe('G5 采集 - 与差异层对接', () => {
  test('远端秒级时间戳与本地毫秒对齐后判成同一个文件（不重传）', async () => {
    const w = await load()
    const m = mirror
    const local = await w.walkLocalTree({
      root: '/root',
      fs: {
        readdirStatAsync: async () => [
          { name: 'a.txt', size: 5, mtimeMs: 1_730_000_000_000, isDirectory: false, isSymbolicLink: false }
        ]
      }
    })
    const remote = await w.walkRemoteTree({
      root: '/srv',
      sftp: {
        list: async () => [{ name: 'a.txt', type: '-', size: 5, modifyTime: 1_730_000_000 }]
      }
    })
    const diff = m.diffTrees(local.entries, remote.entries)
    assert.deepEqual(diff.skip.map(e => e.relPath), ['a.txt'])
    assert.equal(diff.overwrite.length, 0)
    assert.equal(m.planSummary(diff).clean, true)
  })

  test('两端拉平后 relPath 可比：嵌套文件只改那一个', async () => {
    const w = await load()
    const local = await w.walkLocalTree({
      root: '/root',
      fs: {
        readdirStatAsync: async (p) => p === '/root'
          ? [{ name: 'sub', size: 4096, mtimeMs: 1, isDirectory: true, isSymbolicLink: false }]
          : [{ name: 'f.txt', size: 20, mtimeMs: 5, isDirectory: false, isSymbolicLink: false }]
      }
    })
    const remote = await w.walkRemoteTree({
      root: '/srv',
      sftp: {
        list: async (p) => p === '/srv'
          ? [{ name: 'sub', type: 'd', size: 4096, modifyTime: 1 }]
          : [{ name: 'f.txt', type: '-', size: 10, modifyTime: 5 }]
      }
    })
    const diff = mirror.diffTrees(local.entries, remote.entries)
    assert.deepEqual(diff.overwrite.map(e => e.relPath), ['sub/f.txt'])
    assert.deepEqual(diff.createDirs, [])
    assert.equal(diff.bytes, 20)
  })
})
