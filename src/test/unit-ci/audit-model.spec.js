// G8-1：审计中心数据层（纯函数）
//
// 审计视图的敌人是"看起来对但其实猜错"：文件名反解主机是启发式、连接历史里没有
// tab id 所以不能和日志文件合并、时长只有传输与录制才有。判据重点放在
// "解不出就留空，绝不猜"与"导出内容对同一份输入必须逐字节相同"。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/audit-model.js')
const TIME_MOD = path.join(__dirname, '../../client/common/time.js')

let mod
let fmt
const load = async () => {
  if (!mod) {
    mod = await import(pathToFileURL(MOD).href)
    fmt = (await import(pathToFileURL(TIME_MOD).href)).default
  }
  return mod
}

// nanoid(7)：字母数字 + `_` + `-`
const ID = 'aB3dEfG'
const ID_WITH_SEP = 'Ab3_dEf'

const hist = (over = {}) => ({
  id: 'h1',
  time: 1730000000000,
  count: 2,
  tab: { host: '10.0.0.8', username: 'root', type: 'ssh', title: 'web-1' },
  ...over
})

const transfer = (over = {}) => ({
  id: 't1',
  host: '10.0.0.9',
  username: 'dp',
  typeFrom: 'remote',
  typeTo: 'local',
  fromPath: '/var/log/a',
  toPath: '/tmp/a',
  startTime: 1730000000000,
  finishTime: 1730000010000,
  size: 4096,
  ...over
})

describe('G8 会话日志文件名反解', () => {
  test('标题_主机_id：三段都拿得到', async () => {
    const { parseSessionLogName } = await load()
    const r = parseSessionLogName('web-1_10.0.0.8_' + ID + '.log')
    assert.equal(r.ext, '.log')
    assert.equal(r.sessionId, ID)
    assert.equal(r.host, '10.0.0.8')
    assert.equal(r.title, 'web-1')
  })

  test('无标题（书签为空的会话）：整段前缀就是主机', async () => {
    const { parseSessionLogName } = await load()
    const r = parseSessionLogName('10.0.0.8_' + ID + '.log')
    assert.equal(r.sessionId, ID)
    assert.equal(r.host, '10.0.0.8')
    assert.equal(r.title, '')
  })

  test('id 自身带下划线仍然按末尾 7 字符切，不会把 id 拆成两段', async () => {
    const { parseSessionLogName } = await load()
    const r = parseSessionLogName('db_' + ID_WITH_SEP + '.log')
    assert.equal(r.sessionId, ID_WITH_SEP)
    assert.equal(r.host, 'db')
    assert.equal(r.title, '')
  })

  test('已知会误判的形状：无标题且主机名自带下划线 → 主机只剩末段（所以产物列必须原样显示文件名）', async () => {
    const { parseSessionLogName } = await load()
    const r = parseSessionLogName('my_host_' + ID + '.log')
    assert.equal(r.sessionId, ID)
    assert.equal(r.host, 'host')
    assert.equal(r.title, 'my')
  })

  test('标题里带下划线时只要主机段是最后一段就仍然解得对', async () => {
    const { parseSessionLogName } = await load()
    const r = parseSessionLogName('prod_web_1_10.0.0.8_' + ID + '.log')
    assert.equal(r.sessionId, ID)
    assert.equal(r.host, '10.0.0.8')
    assert.equal(r.title, 'prod_web_1')
  })

  test('尾巴不像 id（被 sanitizeFilename 截断的超长名）→ id 与主机都留空', async () => {
    const { parseSessionLogName } = await load()
    // 截断从头保留 255 字节，尾巴上的 id 缺了几位，倒数第 8 个字符不再是分隔符
    const long = 't'.repeat(200) + '_10.0.0.8_' + ID.slice(0, 3)
    const r = parseSessionLogName(long + '.log')
    assert.equal(r.sessionId, '')
    assert.equal(r.host, '')
  })

  test('录制文件名不会被误判出一个主机', async () => {
    const { parseSessionLogName } = await load()
    const r = parseSessionLogName('electerm-rec-20261031-101500.cast')
    assert.equal(r.ext, '.cast')
    assert.equal(r.sessionId, '')
    assert.equal(r.host, '')
  })

  test('没有扩展名 / 多点：只在真有点处分，扩展名取最后一段', async () => {
    const { parseSessionLogName } = await load()
    assert.equal(parseSessionLogName('noext').ext, '')
    assert.equal(parseSessionLogName('a.b.log').ext, '.log')
    assert.equal(parseSessionLogName('a.b.log').base, 'a.b')
  })

  test('空/非字符串入参不抛错，返回空字段', async () => {
    const { parseSessionLogName } = await load()
    for (const v of [undefined, null, 42, '']) {
      const r = parseSessionLogName(v)
      assert.equal(r.sessionId, '')
      assert.equal(r.host, '')
    }
  })
})

describe('G8 三来源合表', () => {
  test('连接历史行：主机/用户/次数来自 tab，时长与产物留空（历史里根本没有）', async () => {
    const { buildAuditRows, KIND } = await load()
    const [r] = buildAuditRows({ history: [hist()] })
    assert.equal(r.kind, KIND.session)
    assert.equal(r.host, '10.0.0.8')
    assert.equal(r.user, 'root')
    assert.equal(r.connType, 'ssh')
    assert.equal(r.count, 2)
    assert.equal(r.duration, null)
    assert.equal(r.artifact, '')
  })

  test('没有 id 的历史项不炸，也只塌陷成一条（同一 key 无法区分，不假装是两个事件）', async () => {
    const { buildAuditRows } = await load()
    const rows = buildAuditRows({ history: [{ id: 'h2' }, undefined, undefined] })
    assert.equal(rows.length, 2)
    assert.ok(rows.every(r => r.host === '' && r.time === null))
  })

  test('传输方向抄 app 自己的口径：本地起算上传，远端互传算第三种', async () => {
    const { buildAuditRows } = await load()
    const rows = buildAuditRows({
      transfers: [
        transfer({ id: 'a', typeFrom: 'local', typeTo: 'remote' }),
        transfer({ id: 'b', typeFrom: 'remote', typeTo: 'local' }),
        transfer({ id: 'c', typeFrom: 'remote', typeTo: 'remote' })
      ]
    })
    const dir = {}
    for (const r of rows) {
      dir[r.key] = r.connType
    }
    assert.equal(dir['transfer:a'], 'upload')
    assert.equal(dir['transfer:b'], 'download')
    assert.equal(dir['transfer:c'], 'remote')
  })

  test('传输行：时长 = 结束 - 开始，错误并进详情', async () => {
    const { buildAuditRows, KIND } = await load()
    const rows = buildAuditRows({
      transfers: [
        transfer(),
        transfer({ id: 't2', error: 'user cancelled', startTime: undefined })
      ]
    })
    const byId = { t1: rows.find(r => r.key === 'transfer:t1'), t2: rows.find(r => r.key === 'transfer:t2') }
    assert.equal(byId.t1.kind, KIND.transfer)
    assert.equal(byId.t1.duration, 10000)
    assert.equal(byId.t1.detail, '/var/log/a → /tmp/a')
    assert.equal(byId.t2.detail, '/var/log/a → /tmp/a (user cancelled)')
    // 只有结束时刻时用它当行时间，而不是当成 0
    assert.equal(byId.t2.time, 1730000010000)
    assert.equal(byId.t2.duration, null)
  })

  test('传输的起止倒挂（时钟被改过）→ 时长留空，不写出负数', async () => {
    const { buildAuditRows } = await load()
    const [r] = buildAuditRows({ transfers: [transfer({ startTime: 5000, finishTime: 1000 })] })
    assert.equal(r.duration, null)
  })

  test('日志/录制行：类型按扩展名分开，录制时长按秒进毫秒', async () => {
    const { buildAuditRows, KIND } = await load()
    const rows = buildAuditRows({
      files: [
        { name: 'web-1_10.0.0.8_' + ID + '.log', size: 2048, mtimeMs: 1730000000000 },
        { name: 'electerm-rec-20261031-101500.cast', size: 1024, mtimeMs: 1730000000000, duration: 12.5, firstCommand: 'ls' }
      ]
    })
    const log = rows.find(r => r.kind === KIND.log)
    const rec = rows.find(r => r.kind === KIND.recording)
    assert.equal(log.host, '10.0.0.8')
    assert.equal(log.detail, 'web-1')
    assert.equal(log.duration, null)
    assert.equal(rec.host, '')
    assert.equal(rec.duration, 12500)
    assert.equal(rec.end, 1730000000000 + 12500)
    assert.equal(rec.detail, 'ls')
  })

  test('录制若探测到起始时刻（cast header 的 timestamp），优先用它而不是 mtime', async () => {
    const { buildAuditRows } = await load()
    const [r] = buildAuditRows({
      files: [{ name: 'a.cast', mtimeMs: 1730000000000, time: 1720000000000, duration: 3 }]
    })
    assert.equal(r.time, 1720000000000)
    assert.equal(r.end, 1720000003000)
  })

  test('合表按时间倒序，没有时刻的行排最后', async () => {
    const { buildAuditRows } = await load()
    const rows = buildAuditRows({
      history: [hist({ id: 'h1', time: undefined }), hist({ id: 'h2', time: 1730000500000 })],
      transfers: [transfer({ id: 't1', startTime: 1730001000000 })],
      files: [{ name: 'x_10.0.0.7_' + ID + '.log', mtimeMs: 1730000800000 }]
    })
    assert.deepEqual(rows.map(r => r.key), [
      'transfer:t1',
      'log:x_10.0.0.7_' + ID + '.log',
      'session:h2',
      'session:h1'
    ])
  })

  test('同一 key 只留一条（历史里被改过 id 会重复推入）', async () => {
    const { buildAuditRows } = await load()
    const rows = buildAuditRows({ history: [hist(), hist()], files: [{ name: 'a.log' }, { name: 'a.log' }] })
    assert.equal(rows.length, 2)
  })

  test('传进来的不是数组（store 还没初始化）→ 空表而不是抛错', async () => {
    const { buildAuditRows } = await load()
    assert.deepEqual(buildAuditRows({}), [])
    assert.deepEqual(buildAuditRows({ history: null, transfers: 'x', files: {} }), [])
  })
})

describe('G8 过滤与分栏', () => {
  const rowsOf = async () => {
    const { buildAuditRows } = await load()
    return buildAuditRows({
      history: [
        hist({ id: 'h1', time: 1730000000000 }),
        hist({ id: 'h2', time: 1730003600000, tab: { host: '10.0.0.9', username: 'dp', type: 'ssh' } })
      ],
      transfers: [transfer({ id: 't1', startTime: 1730007200000 })],
      files: [
        { name: 'web-1_10.0.0.8_' + ID + '.log', mtimeMs: 1730010800000 },
        { name: 'electerm-rec-1.cast', mtimeMs: 1730014400000 }
      ]
    })
  }

  test('空条件不限制：一条不少', async () => {
    const { filterAuditRows } = await load()
    const rows = await rowsOf()
    assert.equal(filterAuditRows(rows, {}).length, rows.length)
    assert.equal(filterAuditRows(rows, { kinds: [], hosts: [], text: '' }).length, rows.length)
  })

  test('按类型筛', async () => {
    const { filterAuditRows, KIND } = await load()
    const rows = await rowsOf()
    const hit = filterAuditRows(rows, { kinds: [KIND.session, KIND.transfer] })
    assert.deepEqual(hit.map(r => r.kind).sort(), ['session', 'session', 'transfer'])
  })

  test('按主机筛：解不出主机的行（录制）在任何主机筛选下都不出现', async () => {
    const { filterAuditRows } = await load()
    const rows = await rowsOf()
    const hit = filterAuditRows(rows, { hosts: ['10.0.0.8'] })
    assert.deepEqual(hit.map(r => r.key).sort(), ['log:web-1_10.0.0.8_' + ID + '.log', 'session:h1'])
  })

  test('时间窗按行时间筛，两端都闭', async () => {
    const { filterAuditRows } = await load()
    const rows = await rowsOf()
    const hit = filterAuditRows(rows, { from: 1730003600000, to: 1730007200000 })
    assert.deepEqual(hit.map(r => r.key), ['transfer:t1', 'session:h2'])
  })

  test('文本命中主机/用户/产物/详情任意一列且不区分大小写', async () => {
    const { filterAuditRows } = await load()
    const rows = await rowsOf()
    // 'web-1' 同时出现在连接历史（标题）和它的日志文件（产物名）里——两行都该命中
    assert.equal(filterAuditRows(rows, { text: 'WEB-1' }).length, 2)
    assert.equal(filterAuditRows(rows, { text: 'dp' }).length, 2)
    assert.equal(filterAuditRows(rows, { text: '/tmp/a' }).length, 1)
    assert.equal(filterAuditRows(rows, { text: 'electerm-rec' }).length, 1)
    assert.equal(filterAuditRows(rows, { text: '不存在的东西' }).length, 0)
  })

  test('主机候选：只列出现过的、带条数、按条数降序', async () => {
    const { facetCounts } = await load()
    const rows = await rowsOf()
    assert.deepEqual(facetCounts(rows, 'host'), [
      { value: '10.0.0.8', count: 2 },
      { value: '10.0.0.9', count: 2 }
    ])
  })

  test('类型候选里没有空值', async () => {
    const { facetCounts, KIND } = await load()
    const rows = await rowsOf()
    const k = facetCounts(rows, 'kind')
    assert.deepEqual(k.map(x => x.value).sort(), [KIND.log, KIND.recording, KIND.session, KIND.transfer].sort())
    assert.ok(k.every(x => x.value !== ''))
  })

  test('按天分桶：天数倒序，无时刻的桶排最后', async () => {
    const { groupByDay, buildAuditRows } = await load()
    const rows = buildAuditRows({
      history: [hist({ id: 'a', time: 1730419200000 }), hist({ id: 'b', time: 1730505600000 }), hist({ id: 'c', time: undefined })]
    })
    const g = groupByDay(rows)
    assert.equal(g.length, 3)
    assert.equal(g[g.length - 1].day, '')
    assert.equal(g[g.length - 1].rows[0].key, 'session:c')
    assert.ok(g[0].day > g[1].day, g.map(x => x.day).join())
  })
})

describe('G8 导出', () => {
  const rowsOf = async () => {
    const { buildAuditRows } = await load()
    return buildAuditRows({
      history: [hist({ id: 'h1', time: 1730000000000 })],
      transfers: [transfer({
        id: 't1',
        startTime: 1730000000000,
        finishTime: 1730000005000,
        toPath: '/tmp/"a",b',
        fromPath: 'line1\nline2'
      })],
      files: [{ name: 'web-1_10.0.0.8_' + ID + '.log', size: 2048, mtimeMs: 1730000000000 }]
    })
  }

  test('CSV：BOM 开头、CRLF 行尾、表头九列', async () => {
    const { auditToCsv } = await load()
    const text = auditToCsv(await rowsOf(), { at: 1730000000000 })
    assert.equal(text.charCodeAt(0), 0xFEFF)
    const lines = text.slice(1).split('\r\n')
    assert.equal(lines[0].split(',').length, 9)
    assert.equal(lines[lines.length - 1], '')
    assert.equal(lines.length - 2, 3)
  })

  test('CSV：逗号/引号/换行都按 RFC 4180 包裹转义', async () => {
    const { auditToCsv } = await load()
    const text = auditToCsv(await rowsOf(), { at: 1730000000000 })
    assert.ok(text.indexOf('"line1\nline2 → /tmp/""a"",b"') > 0, text)
  })

  test('CSV：时长取整秒、缺失一律写 —、时间走本地格式', async () => {
    const { auditToCsv, buildAuditRows } = await load()
    const rows = buildAuditRows({
      transfers: [transfer({ id: 't1', startTime: 0, finishTime: 1500, size: undefined })],
      history: [hist({ id: 'h1', time: 0 })]
    })
    const text = auditToCsv(rows, { at: 0 })
    const lines = text.slice(1).split('\r\n')
    assert.ok(lines.some(l => l.startsWith(fmt(0) + ',transfer,')), text)
    assert.ok(lines.some(l => l.startsWith(fmt(0) + ',session,10.0.0.8,root,')), text)
    assert.ok(lines.some(l => l.indexOf(',2s,') > 0), text)
    // 会话历史行：时长/产物/大小全空，只有次数与详情有值
    assert.ok(lines.some(l => l.endsWith(',—,—,—,2,web-1')), text)
    assert.ok(lines.some(l => l.endsWith(',2s,—,—,1,/var/log/a → /tmp/a')), text)
  })

  test('CSV：同一份行两次导出逐字节相同（留档要能复核）', async () => {
    const { auditToCsv } = await load()
    const rows = await rowsOf()
    assert.equal(auditToCsv(rows, { at: 1730000000000 }), auditToCsv(rows, { at: 1730000000000 }))
  })

  test('CSV：表头能被 labels 换成本地词条，数据列不受影响', async () => {
    const { auditToCsv } = await load()
    const text = auditToCsv(await rowsOf(), { at: 0, labels: { time: '时间', host: '主机' } })
    const head = text.slice(1).split('\r\n')[0]
    assert.ok(head.indexOf('时间') === 0, head)
    assert.ok(head.indexOf('主机') > 0, head)
  })

  test('Markdown：标题 + 两条元信息 + 表头 + 分隔行 + 每行一条', async () => {
    const { auditToMarkdown } = await load()
    const text = auditToMarkdown(await rowsOf(), { at: 1730000000000, title: 'electerm 审计' })
    const lines = text.split('\n')
    assert.equal(lines[0], '# electerm 审计')
    assert.ok(lines[2].startsWith('- '), lines[2])
    assert.equal(lines[3], '- 3 rows')
    const head = lines.findIndex(l => /^\|\s+time\s+\|/.test(l))
    assert.ok(head > 0, text)
    assert.equal(lines[head].split('|').length - 2, 9)
    assert.match(lines[head + 1], /^\|( --- \|){9}$/)
    assert.equal(lines.filter(l => l.startsWith('|')).length, 5)
  })

  test('Markdown：竖线转义、换行压平（否则一行撑成两行）', async () => {
    const { auditToMarkdown, buildAuditRows } = await load()
    const rows = buildAuditRows({
      transfers: [transfer({ id: 't1', fromPath: 'a|b', toPath: 'c\nd' })]
    })
    const text = auditToMarkdown(rows, { at: 0 })
    assert.ok(text.indexOf('a\\|b → c d') > 0, text)
    assert.equal(text.split('\n').filter(l => l.startsWith('|')).length, 3)
  })

  test('空表导出仍然得到合法的表头文件', async () => {
    const { auditToCsv, auditToMarkdown } = await load()
    assert.equal(auditToCsv([], { at: 0 }).split('\r\n').length, 2)
    assert.match(auditToMarkdown([], { at: 0 }), /0 rows/)
  })
})
