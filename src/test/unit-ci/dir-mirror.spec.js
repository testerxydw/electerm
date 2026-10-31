// G5-1：目录镜像的差异计算（纯函数）
//
// 镜像的敌人是"把没变的当变了重传一遍"和"把不该删的删了"：
// SFTP 的时间戳是秒级、FAT 是 2 秒精度、有的服务端不给 mtime、远端目录项的 size
// 是 4096 而不是内容长度。判据重点放在容差边界、时间戳缺失时按大小判定并认账、
// 删除只列文件（目录永远不进 deleteCandidates），以及同一输入逐字节同输出。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/dir-mirror.js')

let mod
const load = async () => {
  if (!mod) {
    mod = await import(pathToFileURL(MOD).href)
  }
  return mod
}

const f = (relPath, size, mtimeMs, extra = {}) => ({
  relPath,
  size,
  mtimeMs,
  isDirectory: false,
  ...extra
})
const d = relPath => ({ relPath, size: 4096, mtimeMs: 1730000000000, isDirectory: true })
const names = arr => arr.map(x => x.relPath)

describe('G5 目录镜像 - relPath 归一', () => {
  test('反斜杠换正斜杠（本地采集器给的原生分隔符）', async () => {
    const m = await load()
    assert.equal(m.normalizeRelPath('a\\b\\c.txt'), 'a/b/c.txt')
  })

  test('前导 ./ 与 / 都去掉', async () => {
    const m = await load()
    assert.equal(m.normalizeRelPath('./a/b'), 'a/b')
    assert.equal(m.normalizeRelPath('/a/b'), 'a/b')
    assert.equal(m.normalizeRelPath('///a'), 'a')
  })

  test('尾部斜杠吞掉：logs/ 与 logs 是同一个东西', async () => {
    const m = await load()
    assert.equal(m.normalizeRelPath('logs/'), 'logs')
    assert.equal(m.normalizeRelPath('logs///'), 'logs')
  })

  test('空 / null / 只有分隔符都归成空串', async () => {
    const m = await load()
    assert.equal(m.normalizeRelPath(''), '')
    assert.equal(m.normalizeRelPath(null), '')
    assert.equal(m.normalizeRelPath(undefined), '')
    assert.equal(m.normalizeRelPath('/'), '')
    assert.equal(m.normalizeRelPath('./'), '')
  })

  test('中间的空路径段不"顺手清理"（那是另一件事）', async () => {
    const m = await load()
    assert.equal(m.normalizeRelPath('a//b'), 'a//b')
  })
})

describe('G5 目录镜像 - 建索引', () => {
  test('空 relPath 的条目直接丢掉，不进索引也不计重复', async () => {
    const m = await load()
    const r = m.indexTree([{ relPath: '' }, { relPath: null }, f('a', 1, 1)])
    assert.equal(r.map.size, 1)
    assert.equal(r.duplicates, 0)
  })

  test('同一棵树里重复 relPath 保留第一条并计数', async () => {
    const m = await load()
    const r = m.indexTree([f('a.txt', 10, 100), f('a.txt', 999, 200)])
    assert.equal(r.duplicates, 1)
    assert.equal(r.map.get('a.txt').size, 10)
  })

  test('归一后的同一路径算重复（./a 与 a\\ 与 a/）', async () => {
    const m = await load()
    const r = m.indexTree([f('./a', 1, 1), f('a/', 2, 2), f('a', 3, 3)])
    assert.equal(r.map.size, 1)
    assert.equal(r.duplicates, 2)
  })
})

describe('G5 目录镜像 - 差异分类', () => {
  test('远端没有 → create；两边大小不同 → overwrite', async () => {
    const m = await load()
    const r = m.diffTrees(
      [f('new.txt', 5, 1000), f('changed.txt', 9, 1000)],
      [f('changed.txt', 8, 1000)]
    )
    assert.deepEqual(names(r.create), ['new.txt'])
    assert.deepEqual(names(r.overwrite), ['changed.txt'])
    assert.deepEqual(r.skip, [])
  })

  test('大小同、mtime 差 1 秒 → skip（秒级精度是常态不是差异）', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 8, 1_000_000)], [f('a', 8, 1_001_000)])
    assert.deepEqual(names(r.skip), ['a'])
    assert.equal(r.overwrite.length, 0)
  })

  test('容差边界：差 1999ms 跳过、差 2000ms 覆盖', async () => {
    const m = await load()
    const ok = m.diffTrees([f('a', 8, 1_000_000)], [f('a', 8, 1_001_999)])
    const bad = m.diffTrees([f('a', 8, 1_000_000)], [f('a', 8, 1_002_000)])
    assert.equal(m.MTIME_TOLERANCE_MS, 2000)
    assert.deepEqual(names(ok.skip), ['a'])
    assert.deepEqual(names(bad.overwrite), ['a'])
  })

  test('mtime 谁新谁旧不重要，只看差够不够大', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 8, 5_000_000)], [f('a', 8, 1_000_000)])
    assert.deepEqual(names(r.overwrite), ['a'])
  })

  test('大小不同时 mtime 根本不参与判断', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 8, 1_000_000)], [f('a', 9, 1_000_000)])
    assert.deepEqual(names(r.overwrite), ['a'])
  })

  test('size-only：大小同就跳过，时间戳差一天也不管', async () => {
    const m = await load()
    const r = m.diffTrees(
      [f('a', 8, 1_000_000)],
      [f('a', 8, 1_000_000 + 86_400_000)],
      { mode: m.MIRROR_MODE.sizeOnly }
    )
    assert.deepEqual(names(r.skip), ['a'])
    assert.equal(r.noTimestamp, 0)
  })

  test('size-only 不掩盖大小差异', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 8, 1), f('b', 1, 1)], [f('a', 7, 99), f('b', 1, 1)],
      { mode: m.MIRROR_MODE.sizeOnly })
    assert.deepEqual(names(r.overwrite), ['a'])
    assert.deepEqual(names(r.skip), ['b'])
  })

  test('认不出 mode 时按默认（size-mtime）走，不静默变成 size-only', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 8, 1_000_000)], [f('a', 8, 9_000_000)], { mode: 'whatever' })
    assert.equal(r.mode, m.MIRROR_MODE.sizeMtime)
    assert.deepEqual(names(r.overwrite), ['a'])
  })

  test('一端没有时间戳 → 按大小跳过，但要单独记一笔', async () => {
    const m = await load()
    const noRemote = m.diffTrees([f('a', 8, 1_000_000)], [f('a', 8, 0)])
    const noLocal = m.diffTrees([f('a', 8, undefined)], [f('a', 8, 1_000_000)])
    const bothNan = m.diffTrees([f('a', 8, NaN)], [f('a', 8, 'abc')])
    assert.deepEqual(names(noRemote.skip), ['a'])
    assert.deepEqual(names(noLocal.skip), ['a'])
    assert.deepEqual(names(bothNan.skip), ['a'])
    assert.equal(noRemote.noTimestamp, 1)
    assert.equal(noLocal.noTimestamp, 1)
    assert.equal(bothNan.noTimestamp, 1)
    assert.equal(noRemote.overwrite.length, 0)
  })

  test('时间戳是字符串数字也算拿到（采集器可能透传协议原值）', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 8, '1730000000000')], [f('a', 8, 1_730_000_000_000)])
    assert.deepEqual(names(r.skip), ['a'])
    assert.equal(r.noTimestamp, 0)
  })

  test('大小认不出（undefined / NaN / 负数）→ 判覆盖并计入 unknownSize', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', undefined, 1), f('b', NaN, 1), f('c', -1, 1)], [])
    assert.deepEqual(names(r.overwrite), [])
    assert.deepEqual(names(r.create).sort(), ['a', 'b', 'c'])
    const r2 = m.diffTrees([f('a', undefined, 1)], [f('a', 5, 1)])
    assert.deepEqual(names(r2.overwrite), ['a'])
    assert.equal(r2.unknownSize, 1)
  })
})

describe('G5 目录镜像 - 目录与撞名', () => {
  test('本地有目录、远端没有 → createDirs，父目录排在子目录前', async () => {
    const m = await load()
    const r = m.diffTrees([d('z'), d('a/b/c'), d('a/b'), d('a')], [])
    const order = r.createDirs.map(x => x.relPath)
    assert.equal(order.indexOf('a') < order.indexOf('a/b'), true)
    assert.equal(order.indexOf('a/b') < order.indexOf('a/b/c'), true)
    assert.equal(order.length, 4)
  })

  test('已存在的目录不产生动作', async () => {
    const m = await load()
    const r = m.diffTrees([d('a'), d('a/b')], [d('a'), d('a/b')])
    assert.deepEqual(r.createDirs, [])
    assert.deepEqual(r.remoteExtra, [])
  })

  test('远端同路径是个文件 → createDirs 标 vsFile（mkdir 会失败，得让人看见）', async () => {
    const m = await load()
    const r = m.diffTrees([d('logs')], [f('logs', 10, 1)])
    assert.equal(r.createDirs.length, 1)
    assert.equal(r.createDirs[0].vsFile, true)
  })

  test('本地是文件、远端同路径是目录 → 不进上传批次，单独列 blocked', async () => {
    const m = await load()
    const r = m.diffTrees([f('data', 10, 1)], [d('data')])
    assert.deepEqual(r.create, [])
    assert.deepEqual(r.overwrite, [])
    assert.deepEqual(names(r.blocked), ['data'])
    assert.equal(r.blocked[0].reason, 'file-vs-dir')
    assert.equal(m.planSummary(r).clean, false)
  })

  test('符号链接两端都不镜像（链接指向的东西不在这棵树里）', async () => {
    const m = await load()
    const r = m.diffTrees(
      [f('link', 1, 1, { isSymbolicLink: true }), f('real', 2, 2)],
      [f('rlink', 1, 1, { isSymbol: true }), f('other', 3, 3)]
    )
    assert.deepEqual(names(r.create), ['real'])
    assert.deepEqual(names(r.remoteExtra), ['other'])
  })
})

describe('G5 目录镜像 - 远端多余项与删除门控', () => {
  test('deleteExtra 关（默认）：remoteExtra 如实报数，deleteCandidates 一个都不给', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 1, 1)], [f('a', 1, 1), f('old.txt', 7, 7), d('olddir')])
    assert.equal(r.deleteExtra, false)
    assert.deepEqual(names(r.remoteExtra), ['old.txt', 'olddir'])
    assert.deepEqual(r.deleteCandidates, [])
    const s = m.planSummary(r)
    assert.equal(s.remoteExtra, 2)
    assert.equal(s.extraDirs, 1)
    assert.equal(s.delete, 0)
    assert.equal(s.clean, true)
  })

  test('deleteExtra 开：只列文件，目录永远不进删除（递归删目录是另一把锤子）', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 1, 1)], [f('a', 1, 1), f('old.txt', 7, 7), d('olddir')],
      { deleteExtra: true })
    assert.deepEqual(names(r.deleteCandidates), ['old.txt'])
    assert.equal(r.deleteCandidates[0].isDirectory, false)
    assert.equal(m.planSummary(r).delete, 1)
    assert.equal(m.planSummary(r).clean, false)
  })

  test('deleteExtra 只认严格的 true（"1" / 1 都不算勾选）', async () => {
    const m = await load()
    for (const v of [1, 'true', '1', {}]) {
      const r = m.diffTrees([], [f('old.txt', 1, 1)], { deleteExtra: v })
      assert.deepEqual(r.deleteCandidates, [], JSON.stringify(v))
    }
  })

  test('remoteExtra 里目录的 size 不被当成内容长度参与字节预估', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 5, 1)], [d('olddir'), f('old.txt', 100, 1)], { deleteExtra: true })
    assert.equal(r.bytes, 5)
  })
})

describe('G5 目录镜像 - 预估与明细', () => {
  test('bytes 只累计 create + overwrite，skip 不算进待传量', async () => {
    const m = await load()
    const r = m.diffTrees(
      [f('a', 10, 1), f('b', 20, 1), f('c', 30, 1)],
      [f('b', 5, 1), f('c', 30, 1)]
    )
    assert.equal(r.bytes, 30)
    assert.deepEqual(names(r.create), ['a'])
    assert.deepEqual(names(r.overwrite), ['b'])
    assert.deepEqual(names(r.skip), ['c'])
  })

  test('分组内按 relPath 升序（面板顺序稳定，判据才可钉）', async () => {
    const m = await load()
    const r = m.diffTrees([f('z.txt', 1, 1), f('a.txt', 2, 1), f('m.txt', 3, 1)], [])
    assert.deepEqual(names(r.create), ['a.txt', 'm.txt', 'z.txt'])
  })

  test('planRows 带上分组名，顺序是 create→overwrite→createDirs→blocked→delete→skip', async () => {
    const m = await load()
    const r = m.diffTrees(
      [f('c', 1, 1), d('nd'), f('o', 2, 2), f('s', 3, 3)],
      [f('o', 9, 9), f('extra', 1, 1), f('s', 3, 3)],
      { deleteExtra: true }
    )
    const rows = m.planRows(r, { limit: 100 })
    assert.deepEqual(rows.rows.map(x => x.group),
      ['create', 'overwrite', 'createDirs', 'delete', 'skip'])
    assert.equal(rows.total, 5)
  })

  test('planRows 截断时如实报 total 与 truncated，不装作只有前 N 条', async () => {
    const m = await load()
    const local = Array.from({ length: 50 }, (_, i) => f('f' + String(i).padStart(3, '0'), i, 1))
    const r = m.diffTrees(local, [])
    const rows = m.planRows(r, { limit: 10 })
    assert.equal(rows.rows.length, 10)
    assert.equal(rows.total, 50)
    assert.equal(rows.truncated, true)
    assert.equal(rows.limit, 10)
  })

  test('planRows 默认上限存在且 limit 非法时回落到默认', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 1, 1)], [])
    assert.ok(m.planRows(r).limit > 0)
    assert.equal(m.planRows(r, { limit: 0 }).limit, m.planRows(r).limit)
    assert.equal(m.planRows(r, { limit: NaN }).limit, m.planRows(r).limit)
  })

  test('planSummary 的 upload 是 create + overwrite，dirs 单独计', async () => {
    const m = await load()
    const r = m.diffTrees([f('a', 1, 1), f('b', 2, 2), d('x')], [f('b', 9, 9)])
    const s = m.planSummary(r)
    assert.equal(s.create, 1)
    assert.equal(s.overwrite, 1)
    assert.equal(s.upload, 2)
    assert.equal(s.createDirs, 1)
    assert.equal(s.skip, 0)
  })

  test('两端全等 → clean，且没有任何动作', async () => {
    const m = await load()
    const tree = [d('a'), f('a/x', 1, 1_000), f('y', 2, 2_000)]
    const r = m.diffTrees(tree, tree)
    const s = m.planSummary(r)
    assert.equal(s.clean, true)
    assert.equal(s.upload, 0)
    assert.equal(s.delete, 0)
    assert.equal(r.bytes, 0)
  })
})

describe('G5 目录镜像 - 确定性与规模', () => {
  test('同一输入跑两次结果逐字节相同', async () => {
    const m = await load()
    const local = [f('b', 1, 1), d('a'), f('a/1', 40, 4000), f('z', 7, 77)]
    const remote = [f('a/1', 41, 4000), d('b'), f('old', 3, 3)]
    const one = m.diffTrees(local, remote, { deleteExtra: true })
    const two = m.diffTrees(local, remote, { deleteExtra: true })
    assert.deepEqual(one, two)
    assert.equal(JSON.stringify(m.planSummary(one)), JSON.stringify(m.planSummary(two)))
  })

  test('输入顺序不影响判定（只影响分组内顺序，已按名排好）', async () => {
    const m = await load()
    const a = m.diffTrees([f('x', 1, 1), f('y', 2, 2)], [f('y', 9, 9)])
    const b = m.diffTrees([f('y', 2, 2), f('x', 1, 1)], [f('y', 9, 9)])
    assert.deepEqual(a, b)
  })

  test('空输入不炸：两端都空 → 全零且 clean', async () => {
    const m = await load()
    const r = m.diffTrees([], [])
    assert.equal(m.planSummary(r).clean, true)
    assert.equal(r.bytes, 0)
    assert.deepEqual(m.diffTrees(undefined, undefined).create, [])
  })

  test('1000 文件预演 <300ms（§14.6 的验收线）', async () => {
    const m = await load()
    const local = Array.from({ length: 1000 }, (_, i) => f('d' + (i % 10) + '/f' + i, i, 1_000_000 + i))
    const remote = Array.from({ length: 1000 }, (_, i) => f('d' + (i % 10) + '/f' + i, i + 1, 1_000_000 + i))
    const t = Date.now()
    const r = m.diffTrees(local, remote)
    const ms = Date.now() - t
    assert.equal(r.overwrite.length, 1000)
    assert.ok(ms < 300, '预演耗时 ' + ms + 'ms')
  })

  test('模块默认导出把出口点齐（界面只 import 一次）', async () => {
    const m = await load()
    for (const k of ['MIRROR_MODE', 'MTIME_TOLERANCE_MS', 'normalizeRelPath',
      'indexTree', 'diffTrees', 'planRows', 'planSummary']) {
      assert.ok(m.default[k], k + ' 未从默认导出暴露')
    }
  })
})
