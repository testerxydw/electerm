// G8-2：审计文件的列目录与尾部读取（主进程）
//
// 这一层唯一的真风险还是路径：渲染层递进来的文件名可以是任何东西，而它要的只是
// "在会话日志目录里看一个 .log/.cast"，不是任意文件读取。第二重的风险是内存：
// 终端日志能长到几百 MB，所以读尾部必须同时有字节窗口与行数上限，
// 而且窗口切在半行上时那半行要丢掉——审计面板里出现半截 ANSI 转义比少一行难查得多。
const { describe, test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const A = require('../../app/lib/audit-files')
const { LIST_MAX } = require('../../app/lib/session-recordings')

let root
// 每组各用一个子目录：列目录的判据会被别的组的文件污染，隔离比顺序可靠
const sub = (name) => {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const write = (dir, name, text) => {
  fs.writeFileSync(path.join(dir, name), text)
  return name
}

// 定长行：字节窗口切在哪都能算出预期结果
const LINE_LEN = 100
const rowOf = (i) => 'x'.repeat(LINE_LEN - 7) + '|' + String(i).padStart(6, '0')
// 必须比字节窗口装得多（1MB / 101 字节 ≈ 10381 行），否则测不出"只读了末尾一段"
const BIG_LINES = 11000
const bigLog = (n) => {
  const parts = []
  for (let i = 0; i < n; i++) {
    parts.push(rowOf(i))
  }
  return parts.join('\n') + '\n'
}

before(() => {
  // 一次性目录放 os.tmpdir()：仓库内删除会走运行时的"安全删除"垫片
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-audit-files-'))
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('G8 审计目录：列出', () => {
  test('目录还没建（从没开过日志与录制）→ 空列表 + exists:false，不是错误', () => {
    const r = A.listAuditFiles(path.join(root, 'never-created'))
    assert.deepEqual(r.files, [])
    assert.equal(r.total, 0)
    assert.equal(r.exists, false)
  })

  test('.log 与 .cast 都列，其它扩展名、无扩展名与目录都不列', () => {
    const d = sub('ext-filter')
    write(d, 's_web_1_host_abc1234.log', 'a\n')
    write(d, 'electerm-rec-20261031-101500.cast', '{"version":2}\n')
    write(d, 'notes.txt', 'ignore me')
    write(d, 'noext', 'ignore me too')
    fs.mkdirSync(path.join(d, 'fake.log'), { recursive: true })
    const r = A.listAuditFiles(d)
    assert.deepEqual(r.files.map(f => f.name).sort(), [
      'electerm-rec-20261031-101500.cast',
      's_web_1_host_abc1234.log'
    ])
    assert.equal(r.exists, true)
    assert.equal(r.total, 2)
  })

  test('带出大小与 mtime，按 mtime 从新到旧', () => {
    const d = sub('sort')
    write(d, 'old.log', '1')
    write(d, 'mid.log', '22')
    write(d, 'new.log', '333')
    const t = Date.now()
    for (const [name, ago] of [['old.log', 9000], ['mid.log', 5000], ['new.log', 1000]]) {
      const when = new Date(t - ago)
      fs.utimesSync(path.join(d, name), when, when)
    }
    const r = A.listAuditFiles(d)
    assert.deepEqual(r.files.map(f => f.name), ['new.log', 'mid.log', 'old.log'])
    assert.equal(r.files[0].size, 3)
    assert.ok(r.files[0].mtimeMs > r.files[2].mtimeMs)
  })

  test('堆了几千个文件时列表截到上限，但 total 报真实数（界面得能说"只是前 N 条"）', () => {
    const d = sub('cap')
    const many = LIST_MAX + 20
    for (let i = 0; i < many; i++) {
      write(d, 'f' + String(i).padStart(5, '0') + '.log', 'x')
    }
    const r = A.listAuditFiles(d)
    assert.equal(r.files.length, LIST_MAX)
    assert.equal(r.total, many)
  })

  test('列完就被删的文件只少一条，不让整页失败', () => {
    const d = sub('raced')
    write(d, 'keep.log', 'x')
    write(d, 'gone.log', 'x')
    const names = fs.readdirSync(d)
    fs.rmSync(path.join(d, 'gone.log'), { force: true })
    const r = A.listAuditFiles(d)
    assert.ok(names.includes('gone.log'))
    assert.deepEqual(r.files.map(f => f.name), ['keep.log'])
  })
})

describe('G8 读日志尾部：行数与字节上限', () => {
  let d
  before(() => {
    d = sub('tail')
    write(d, 'tail.log', 'l1\nl2\nl3\n')
    write(d, 'big.log', bigLog(BIG_LINES))
    write(d, 'crlf.log', 'a\r\nb\rc\n')
    write(d, 'empty.log', '')
    write(d, 'nolf.log', 'only-one-line-no-newline')
  })

  test('小文件：整份给，truncated:false，omitted:0，带出大小与 mtime', () => {
    const r = A.readLogTail(d, 'tail.log')
    assert.deepEqual(r.lines, ['l1', 'l2', 'l3'])
    assert.equal(r.truncated, false)
    assert.equal(r.omitted, 0)
    assert.equal(r.size, 9)
    assert.ok(Number.isFinite(r.mtimeMs))
  })

  test('末尾换行不产生空尾行；整份没有换行也不多出空行', () => {
    assert.equal(A.readLogTail(d, 'tail.log').lines.length, 3)
    assert.deepEqual(A.readLogTail(d, 'nolf.log').lines, ['only-one-line-no-newline'])
  })

  test('空文件（0 字节）给空数组，不抛', () => {
    const r = A.readLogTail(d, 'empty.log')
    assert.deepEqual(r.lines, [])
    assert.equal(r.truncated, false)
  })

  test('\\r\\n 与裸 \\r（进度条那种）都算换行', () => {
    assert.deepEqual(A.readLogTail(d, 'crlf.log').lines, ['a', 'b', 'c'])
  })

  test('默认只要 500 行，取的是最末尾那 500 行', () => {
    const r = A.readLogTail(d, 'big.log')
    assert.equal(r.lines.length, A.TAIL_LINES)
    assert.equal(r.lines[r.lines.length - 1], rowOf(BIG_LINES - 1))
    assert.equal(r.lines[0], rowOf(BIG_LINES - A.TAIL_LINES))
    assert.equal(r.truncated, true)
  })

  test('渲染层可以少要，不能多要：行数钳在 TAIL_LINES_MAX，非法入参回落到默认', () => {
    assert.equal(A.readLogTail(d, 'big.log', 10).lines.length, 10)
    assert.equal(A.readLogTail(d, 'big.log', 999999).lines.length, A.TAIL_LINES_MAX)
    assert.equal(A.readLogTail(d, 'big.log', 'abc').lines.length, A.TAIL_LINES)
    assert.equal(A.readLogTail(d, 'big.log', 0).lines.length, A.TAIL_LINES)
  })

  test('超过字节窗口时只读末尾一段并如实标 truncated；被窗口切掉的半行不出现', () => {
    const r = A.readLogTail(d, 'big.log', 10)
    assert.equal(r.truncated, true)
    assert.ok(r.size > A.TAIL_WINDOW, String(r.size))
    // 每行都必须是完整的定长行：出现残片就说明首行没丢掉
    for (const l of r.lines) {
      assert.equal(l.length, LINE_LEN, JSON.stringify(l))
    }
    assert.equal(r.lines[r.lines.length - 1], rowOf(BIG_LINES - 1))
  })

  test('omitted 只统计窗口里没给出的行，不虚报总行数', () => {
    const r = A.readLogTail(d, 'big.log', 5)
    assert.equal(r.lines.length, 5)
    assert.ok(r.omitted > 0, String(r.omitted))
    assert.ok(r.omitted <= Math.floor(A.TAIL_WINDOW / (LINE_LEN + 1)))
  })
})

describe('G8 审计文件路径闸', () => {
  const outside = path.join(os.tmpdir(), 'electerm-audit-outside.log')
  let d

  before(() => {
    d = sub('guard')
    fs.writeFileSync(outside, 'DO NOT READ ME')
    write(d, 'ok.log', 'x\n')
  })

  after(() => {
    fs.rmSync(outside, { force: true })
  })

  test('相对路径、绝对路径、子目录都出不了目录，且目录外那个文件没被动过', () => {
    for (const bad of ['../electerm-audit-outside.log', outside, '../../etc/passwd.log', 'sub/x.log']) {
      assert.throws(() => A.readLogTail(d, bad), '未拒: ' + bad)
      assert.throws(() => A.resolveAny(d, bad), '未拒: ' + bad)
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'DO NOT READ ME')
  })

  test('扩展名不对一律拒：.cast 不归 readLogTail 管，空名与点也算拒', () => {
    for (const bad of ['x.cast', 'x.log.txt', 'x.txt', '', '.', '..']) {
      assert.throws(() => A.readLogTail(d, bad), '未拒: ' + JSON.stringify(bad))
    }
  })

  test('resolveAny 两种扩展名都放行（在文件管理器里定位不该分家）', () => {
    write(d, 'show-me.cast', 'x')
    assert.equal(path.basename(A.resolveAny(d, 'show-me.log')), 'show-me.log')
    assert.equal(path.basename(A.resolveAny(d, 'show-me.cast')), 'show-me.cast')
    assert.throws(() => A.resolveAny(d, 'show-me.txt'))
  })

  test('目录伪装成 .log 时明确报错，不把 EISDIR 漏给渲染层', () => {
    fs.mkdirSync(path.join(d, 'dir.log'), { recursive: true })
    assert.throws(() => A.readLogTail(d, 'dir.log'), /not a file/)
  })

  test('文件列完就被删：readLogTail 抛而不是给个空壳', () => {
    write(d, 'vanished.log', 'x\n')
    fs.rmSync(path.join(d, 'vanished.log'), { force: true })
    assert.throws(() => A.readLogTail(d, 'vanished.log'))
  })
})
