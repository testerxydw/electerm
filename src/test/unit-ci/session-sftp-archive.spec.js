const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { Sftp } = require('../../app/server/session-sftp')
const { NO_ZIP_MARKER } = require('../../app/common/remote-archive')

/**
 * 假 exec 客户端：记录真正发出去的命令，并按脚本回 code/stdout/stderr。
 * execBuffered 读的是 stream 的 data/close 与 stream.stderr 的 data，
 * 所以这里必须给一个带 stderr 子流的双向假流，不能只 resolve 一个字符串。
 */
function fakeClient (respond) {
  const calls = []
  return {
    calls,
    exec (cmd, opts, cb) {
      calls.push(cmd)
      const res = typeof respond === 'function' ? respond(cmd, calls.length) : (respond || {})
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      setImmediate(() => {
        if (res.stdout) {
          stream.emit('data', Buffer.from(String(res.stdout), 'utf8'))
        }
        if (res.stderr) {
          stream.stderr.emit('data', Buffer.from(String(res.stderr), 'utf8'))
        }
        stream.emit('close', typeof res.code === 'number' ? res.code : 0)
      })
      cb(null, stream)
    }
  }
}

const newSession = ({ platform = 'posix', respond, enableSsh = true } = {}) => {
  const inst = new Sftp({ enableSsh }, null, true)
  inst.enableSsh = enableSsh
  // 跳过远端平台探测（要活的 SSH 连接）
  inst.remoteExecPlatform = platform
  inst.client = fakeClient(respond)
  return inst
}

const ok3 = { code: 0, stdout: '', stderr: '' }

describe('sftp archive: 打包', () => {
  test('tar.gz 发出去的就是 remote-archive 拼的那条命令', async () => {
    const inst = newSession({ respond: ok3 })
    const r = await inst.archiveCreate({
      kind: 'tar.gz',
      sources: ['/srv/data/a.txt', '/srv/data/日志 目录'],
      dest: '/srv/data/打包 out.tar.gz'
    })
    assert.deepEqual(inst.client.calls, [
      'tar -czf "/srv/data/打包 out.tar.gz" -C "/srv/data" -- "a.txt" "日志 目录"'
    ])
    assert.equal(r.producedPath, '/srv/data/打包 out.tar.gz')
    assert.equal(r.fallback, false)
    assert.equal(r.noticeKey, null)
  })

  test('stdout 里有降级标记 → 产出路径换成 tar.gz 并带上提示 key', async () => {
    const inst = newSession({ respond: { code: 0, stdout: NO_ZIP_MARKER + '\n', stderr: '' } })
    const r = await inst.archiveCreate({
      kind: 'zip',
      sources: ['/srv/data/a.txt'],
      dest: '/srv/data/out.zip'
    })
    assert.equal(r.fallback, true)
    assert.equal(r.producedPath, '/srv/data/out.tar.gz')
    assert.equal(r.kind, 'tar.gz')
    assert.equal(r.noticeKey, 'remoteArchiveNoZip')
  })

  test('没有标记就是真 zip，不谎报降级', async () => {
    const inst = newSession({ respond: ok3 })
    const r = await inst.archiveCreate({
      kind: 'zip',
      sources: ['/srv/data/a.txt'],
      dest: '/srv/data/out.zip'
    })
    assert.equal(r.fallback, false)
    assert.equal(r.producedPath, '/srv/data/out.zip')
    assert.equal(r.noticeKey, null)
  })

  test('成功时的 stderr 警告不算失败，但原样留个尾巴给 UI', async () => {
    const inst = newSession({
      respond: { code: 0, stdout: '', stderr: 'tar: 剔除开始目录的leading slash\n' }
    })
    const r = await inst.archiveCreate({
      kind: 'tar.gz',
      sources: ['/srv/a'],
      dest: '/srv/o.tar.gz'
    })
    assert.equal(r.producedPath, '/srv/o.tar.gz')
    assert.match(r.stderrTail, /tar:/)
  })

  test('退出码非 0 → 报错带 stderr 原文，且不做「有 stderr 就失败」的误判', async () => {
    const inst = newSession({
      respond: { code: 2, stdout: '', stderr: 'tar: /srv/gone: Cannot stat: No such file or directory\n' }
    })
    await assert.rejects(
      () => inst.archiveCreate({ kind: 'tar.gz', sources: ['/srv/gone'], dest: '/srv/o.tar.gz' }),
      (e) => {
        assert.equal(e.exitCode, 2)
        assert.match(e.message, /Cannot stat/)
        return true
      }
    )
  })

  test('非 0 且一声不吭时也不能返回空错误', async () => {
    const inst = newSession({ respond: { code: 127, stdout: '', stderr: '' } })
    await assert.rejects(
      () => inst.archiveCreate({ kind: 'tar.gz', sources: ['/srv/a'], dest: '/srv/o.tar.gz' }),
      /archive create failed \(exit 127\)/
    )
  })

  test('windows 平台走 PowerShell 模板', async () => {
    const inst = newSession({ platform: 'windows', respond: ok3 })
    await inst.archiveCreate({
      kind: 'zip',
      sources: ['C:\\data\\日志'],
      dest: 'C:\\data\\out.zip'
    })
    assert.equal(inst.client.calls.length, 1)
    assert.match(inst.client.calls[0], /^powershell\.exe -NoLogo -NonInteractive -NoProfile -Command "/)
    assert.ok(inst.client.calls[0].includes('Compress-Archive'))
  })

  // 文件管理器给的远端 Windows 路径是 SFTP 形态（/C:/…），exec 要的是 C:/…
  test('/C:/ 形态的源路径在发命令前归一，不把 /C: 当目录', async () => {
    const inst = newSession({ platform: 'windows', respond: ok3 })
    const r = await inst.archiveExtract({ archivePath: '/C:/data/o.zip', destDir: '/C:/data/out' })
    const cmd = inst.client.calls[0]
    assert.equal(inst.client.calls.length, 1)
    assert.ok(cmd.includes(Buffer.from('C:/data/o.zip', 'utf8').toString('base64')), cmd)
    assert.ok(cmd.includes(Buffer.from('C:/data/out', 'utf8').toString('base64')), cmd)
    assert.equal(cmd.includes('/C:/data'), false, cmd)
    assert.equal(r.destDir, '/C:/data/out')
  })

  test('非法入参在发命令之前就被挡掉（连接上一次都不该碰）', async () => {
    const inst = newSession({ respond: ok3 })
    await assert.rejects(
      () => inst.archiveCreate({ kind: 'tar.gz', sources: ['rel/a'], dest: '/srv/o.tar.gz' }),
      /absolute/
    )
    // zip 的降级名靠替换 .zip 得出，落点后缀不对就必须先挡下
    await assert.rejects(
      () => inst.archiveCreate({ kind: 'zip', sources: ['/srv/a'], dest: '/srv/o.tar.gz' }),
      /must end with \.zip/
    )
    await assert.rejects(
      () => inst.archiveCreate({ kind: 'tar.gz', sources: ['/srv/a\nb'], dest: '/srv/o.tar.gz' }),
      /newline/
    )
    assert.deepEqual(inst.client.calls, [])
  })

  test('纯 SFTP（无 exec 通道）直接说人话，不去跑命令', async () => {
    const inst = newSession({ enableSsh: false, respond: ok3 })
    await assert.rejects(
      () => inst.archiveCreate({ kind: 'tar.gz', sources: ['/srv/a'], dest: '/srv/o.tar.gz' }),
      /SSH exec channel/
    )
    assert.deepEqual(inst.client.calls, [])
  })
})

describe('sftp archive: 清单与解压', () => {
  test('按后缀选 tar / unzip，解析出条目与截断标记', async () => {
    const inst = newSession({
      respond: { code: 0, stdout: 'a/\r\na/b.txt\r\n c.txt \r\n', stderr: '' }
    })
    const r = await inst.archiveList({ archivePath: '/srv/o.tar.gz' })
    assert.deepEqual(inst.client.calls, ['tar -tzf "/srv/o.tar.gz"'])
    assert.equal(r.kind, 'tar-gz')
    assert.deepEqual(r.entries, ['a/b.txt', ' c.txt'])
    assert.equal(r.total, 2)
    assert.equal(r.truncated, false)

    const z = newSession({ respond: { code: 0, stdout: 'x.txt\n', stderr: '' } })
    const rz = await z.archiveList({ archivePath: '/srv/o.zip' })
    assert.deepEqual(z.client.calls, ['unzip -Z1 "/srv/o.zip"'])
    assert.equal(rz.kind, 'zip')
  })

  test('清单上限：超出只截断，条目总数照实回报', async () => {
    const many = new Array(10).fill(0).map((_, i) => 'f' + i).join('\n')
    const inst = newSession({ respond: { code: 0, stdout: many, stderr: '' } })
    const r = await inst.archiveList({ archivePath: '/srv/o.tar', max: 4 })
    assert.equal(r.entries.length, 4)
    assert.equal(r.total, 10)
    assert.equal(r.truncated, true)
  })

  test('认不出类型的归档不解也不列，命令不外发', async () => {
    const inst = newSession({ respond: ok3 })
    await assert.rejects(() => inst.archiveList({ archivePath: '/srv/o.txt' }), /unsupported archive type/)
    await assert.rejects(
      () => inst.archiveExtract({ archivePath: '/srv/o.txt', destDir: '/srv' }),
      /unsupported archive type/
    )
    assert.deepEqual(inst.client.calls, [])
  })

  test('解压：tar 用 -C、unzip 用 -d，成功后回报目标目录', async () => {
    const inst = newSession({ respond: ok3 })
    const r = await inst.archiveExtract({ archivePath: '/srv/o.tar.gz', destDir: '/srv/出 来' })
    assert.deepEqual(inst.client.calls, ['tar -xf "/srv/o.tar.gz" -C "/srv/出 来"'])
    assert.equal(r.ok, true)
    assert.equal(r.destDir, '/srv/出 来')

    const z = newSession({ respond: ok3 })
    await z.archiveExtract({ archivePath: '/srv/o.zip', destDir: '/srv/out' })
    assert.deepEqual(z.client.calls, ['unzip -q -o "/srv/o.zip" -d "/srv/out"'])
  })

  test('解压相对目录 / 带换行路径一律拒绝', async () => {
    const inst = newSession({ respond: ok3 })
    await assert.rejects(
      () => inst.archiveExtract({ archivePath: '/srv/o.zip', destDir: 'srv/out' }),
      /absolute/
    )
    await assert.rejects(
      () => inst.archiveExtract({ archivePath: '/srv/o.zip', destDir: '/sr\nv' }),
      /newline/
    )
    assert.deepEqual(inst.client.calls, [])
  })

  test('解压失败把远端错误带出来，不吞 stderr', async () => {
    const inst = newSession({
      respond: { code: 1, stdout: '', stderr: 'tar: This does not look like a tar archive\n' }
    })
    await assert.rejects(
      () => inst.archiveExtract({ archivePath: '/srv/o.tar', destDir: '/srv' }),
      (e) => {
        assert.match(e.message, /does not look like a tar archive/)
        assert.match(e.stderrTail, /tar:/)
        return true
      }
    )
  })
})
