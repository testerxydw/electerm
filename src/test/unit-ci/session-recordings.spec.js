// G2-2：录制文件的列目录 / 读取 / 探测 / 删除（主进程）
//
// 这一层唯一的风险是路径：渲染层递进来的文件名可以是任何东西，
// 而它拿到的是"在会话日志目录里挑一个文件"的能力，不是读写任意路径的能力。
// 所以判据重点在越界尝试（`../`、绝对路径、非 .cast）与"读不到时怎么降级"。
const { describe, test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const R = require('../../app/lib/session-recordings')

const H = '{"version":2,"width":80,"height":24,"timestamp":1730000000}'
const line = (t, type, data) => JSON.stringify([t, type, data])

let dir
const write = (name, text) => {
  fs.writeFileSync(path.join(dir, name), text)
  return name
}

before(() => {
  // 一次性目录放 os.tmpdir()：仓库内删除会走运行时的"安全删除"垫片
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-rec-store-'))
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('G2 录制目录：列出', () => {
  test('目录不存在（从没录过）是空列表，不是错误', () => {
    const r = R.listRecordings(path.join(dir, 'nope'))
    assert.deepEqual(r.files, [])
    assert.equal(r.total, 0)
  })

  test('只列 .cast 平铺文件，忽略其它扩展名与同名目录', () => {
    write('a.cast', H + '\n' + line(0.1, 'o', 'x') + '\n')
    write('b.txt', 'not a cast')
    fs.mkdirSync(path.join(dir, 'sub.cast'), { recursive: true })
    const r = R.listRecordings(dir)
    assert.deepEqual(r.files.map(f => f.name).filter(n => n === 'a.cast'), ['a.cast'])
    assert.ok(!r.files.some(f => f.name === 'b.txt'))
    assert.ok(!r.files.some(f => f.name === 'sub.cast'), '目录不该进列表')
    assert.ok(r.files.every(f => typeof f.size === 'number' && typeof f.mtimeMs === 'number'))
  })

  test('按修改时间倒序（列表默认看最近的录制）', () => {
    write('old.cast', H + '\n')
    write('mid.cast', H + '\n')
    write('new.cast', H + '\n')
    fs.utimesSync(path.join(dir, 'old.cast'), 1000, 1000)
    fs.utimesSync(path.join(dir, 'mid.cast'), 2000, 2000)
    fs.utimesSync(path.join(dir, 'new.cast'), 3000, 3000)
    const names = R.listRecordings(dir).files.map(f => f.name)
    assert.deepEqual(
      names.filter(n => n.endsWith('.cast') && ['old', 'mid', 'new'].includes(n.replace('.cast', ''))),
      ['new.cast', 'mid.cast', 'old.cast']
    )
  })

  test('超过上限只截断列表，total 仍是真实条数（界面要说"共 N 个"）', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-rec-many-'))
    try {
      for (let i = 0; i < R.LIST_MAX + 3; i++) {
        fs.writeFileSync(path.join(d, `r${i}.cast`), H + '\n')
      }
      const r = R.listRecordings(d)
      assert.equal(r.files.length, R.LIST_MAX)
      assert.equal(r.total, R.LIST_MAX + 3)
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('G2 录制读取', () => {
  test('整份读取带大小与 truncated=false', () => {
    const text = H + '\n' + line(0.1, 'o', '你好') + '\n'
    write('full.cast', text)
    const r = R.readRecording(dir, 'full.cast')
    assert.equal(r.text, text)
    assert.equal(r.truncated, false)
    assert.equal(r.size, Buffer.byteLength(text))
  })

  test('超上限只给前段并标 truncated（尾部半行交给解析层降级）', () => {
    const body = Array.from({ length: 40 }, (_, i) => line(i / 10, 'o', 'x'.repeat(50))).join('\n')
    write('big.cast', H + '\n' + body + '\n')
    const r = R.readRecording(dir, 'big.cast', 200)
    assert.equal(r.truncated, true)
    assert.ok(r.size > 200)
    assert.ok(r.text.startsWith(H), 'header 必须在最前面')
    assert.ok(r.text.length < r.size)
  })

  test('文件不存在直接抛，不返回空文本冒充空录制', () => {
    assert.throws(() => R.readRecording(dir, 'missing.cast'))
  })
})

describe('G2 录制探测（列表页列）', () => {
  test('小文件给整段 head、tail 为空', () => {
    write('small.cast', H + '\n' + line(0.1, 'o', 'a') + '\n')
    const p = R.probeRecordings(dir, ['small.cast'])
    assert.ok(p['small.cast'].head.startsWith('{"version":2'))
    assert.equal(p['small.cast'].tail, '')
  })

  test('大文件 tail 拿到末段（时长在文件末尾，不在头部）', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => line(i / 5, 'o', 'y'.repeat(80))).join('\n')
    write('long.cast', H + '\n' + rows + '\n')
    const p = R.probeRecordings(dir, ['long.cast'])
    assert.ok(p['long.cast'].size > R.PROBE_HEAD)
    assert.ok(p['long.cast'].tail.includes('"o"'))
    assert.ok(!p['long.cast'].tail.includes(H), 'tail 不该把 header 也带上')
  })

  test('单个坏文件只标在该文件上，不让整页失败', () => {
    write('ok.cast', H + '\n')
    const p = R.probeRecordings(dir, ['ok.cast', 'gone.cast', 'evil.txt'])
    assert.equal(p['ok.cast'].error, undefined)
    assert.ok(p['gone.cast'].error, '不存在的文件应有 error')
    assert.ok(p['evil.txt'].error, '非 .cast 应被拒并标 error')
  })

  test('探测有条数上限（一页列表不该拖全目录进内存）', () => {
    const names = Array.from({ length: 5 }, (_, i) => write(`p${i}.cast`, H + '\n'))
    const p = R.probeRecordings(dir, names, 2)
    assert.equal(Object.keys(p).length, 2)
  })
})

describe('G2 路径越界', () => {
  const secrets = os.tmpdir() + '/electerm-rec-outside.cast'
  before(() => {
    fs.writeFileSync(secrets, 'DO NOT TOUCH')
  })
  after(() => {
    fs.rmSync(secrets, { force: true })
  })

  test('相对路径 .. 与绝对路径都出不了目录', () => {
    for (const bad of ['../electerm-rec-outside.cast', secrets, '../../etc/passwd.cast', '/absolute/x.cast', 'sub/x.cast']) {
      assert.throws(() => R.resolveInDir(dir, bad), '未拒: ' + bad)
      assert.throws(() => R.readRecording(dir, bad))
      assert.throws(() => R.deleteRecording(dir, bad))
    }
    assert.equal(fs.readFileSync(secrets, 'utf8'), 'DO NOT TOUCH', '目录外的文件必须没被动过')
  })

  test('非 .cast 扩展名一律拒（包括 .cast.txt 与空名）', () => {
    for (const bad of ['x.cast.txt', 'x.txt', '', '.', '../']) {
      assert.throws(() => R.resolveInDir(dir, bad), '未拒: ' + JSON.stringify(bad))
    }
  })

  test('目录名伪装成录制也拒（sub.cast/ 是目录，不是文件）', () => {
    fs.mkdirSync(path.join(dir, 'dir.cast'), { recursive: true })
    assert.throws(() => R.readRecording(dir, 'dir.cast'))
    assert.ok(!R.listRecordings(dir).files.some(f => f.name === 'dir.cast'))
  })
})

describe('G2 删除', () => {
  test('删除后文件确实没了；删不存在的报错而不是静默成功', () => {
    write('del.cast', H + '\n')
    assert.equal(R.deleteRecording(dir, 'del.cast').deleted, true)
    assert.equal(fs.existsSync(path.join(dir, 'del.cast')), false)
    assert.throws(() => R.deleteRecording(dir, 'del.cast'))
  })

  test('只删被点名的那一个，其它录制不动', () => {
    write('keep1.cast', H + '\n')
    write('keep2.cast', H + '\n')
    R.deleteRecording(dir, 'keep1.cast')
    assert.equal(fs.existsSync(path.join(dir, 'keep1.cast')), false)
    assert.equal(fs.existsSync(path.join(dir, 'keep2.cast')), true)
  })
})

describe('G2 主进程接线', () => {
  const ipcSrc = fs.readFileSync(path.join(__dirname, '../../app/lib/ipc.js'), 'utf8')
  const block = name => {
    const m = ipcSrc.match(new RegExp('const ' + name + ' = [^\\n]*\\n'))
    assert.ok(m, 'ipc.js 里找不到 ' + name)
    return m[0]
  }

  test('五个入口都注册进 asyncGlobals（漏一个就是渲染层调用时静默 undefined）', () => {
    for (const name of ['listRecordings', 'readRecording', 'probeRecordings', 'deleteRecording', 'showRecordingInFolder']) {
      assert.ok(block(name), name)
      assert.match(ipcSrc, new RegExp('\\n    ' + name + ','), name + ' 未挂进 asyncGlobals')
    }
  })

  test('目录由主进程按配置算，渲染层没有选目录的入口', () => {
    for (const name of ['listRecordings', 'readRecording', 'probeRecordings', 'deleteRecording', 'showRecordingInFolder']) {
      const src = block(name)
      assert.ok(src.includes('getSessionLogDir()'), name + ' 必须用配置里的日志目录')
      assert.ok(!/async \((dir|[^)]*dir)/.test(src), name + ' 不能收渲染层传来的目录参数')
    }
  })

  test('录制写入白名单没被放宽：appendRecFile 仍只认 createRecordFile 建过的路径', () => {
    assert.match(ipcSrc, /if \(!recRecordFiles\.has\(path\)\)/)
    assert.match(ipcSrc, /recRecordFiles\.add\(path\)/)
  })
})
