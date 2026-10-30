// G4 归档（渲染层）：认后缀 + 默认归档名
// 重点是"默认名不能自己咬自己"：打包 a.tar.gz 时产出名等于源名，
// 主进程会按「归档装在被打包的东西里面」拒掉，给这种默认名等于给个必错的输入框。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/remote-archive.js')

let mod
const load = async () => {
  if (!mod) {
    mod = await import(pathToFileURL(MOD).href)
  }
  return mod
}

// 固定时刻，时间戳分支才可断言
const AT = new Date(2026, 9, 30, 12, 34, 56)

describe('remote-archive 渲染层：认后缀', () => {
  test('只认这四种后缀，大小写不分', async () => {
    const { isArchiveName } = await load()
    for (const n of ['a.tar.gz', 'a.tgz', 'a.tar', 'a.ZIP', '日志.tar.gz']) {
      assert.equal(isArchiveName(n), true, n)
    }
    for (const n of ['a.txt', 'a.gz', 'a.tar.gzz', 'tar.gz', '', null, 'a.zip.bak']) {
      assert.equal(isArchiveName(n), false, String(n))
    }
  })

  test('baseName 两种分隔符都认', async () => {
    const { baseName } = await load()
    assert.equal(baseName('/srv/data/日志 目录'), '日志 目录')
    assert.equal(baseName('C:\\data\\a.txt'), 'a.txt')
    assert.equal(baseName('D:/data/a.txt'), 'a.txt')
    assert.equal(baseName('a.txt'), 'a.txt')
    assert.equal(baseName('/'), '')
  })
})

describe('remote-archive 渲染层：默认归档名', () => {
  test('单选普通文件 → 原名 + 后缀', async () => {
    const { defaultArchiveName } = await load()
    assert.equal(
      defaultArchiveName({ names: ['app.js'], kind: 'tar.gz', dirName: '/srv/data', at: AT }),
      'app.js.tar.gz'
    )
    assert.equal(
      defaultArchiveName({ names: ['日志'], kind: 'zip', dirName: '/srv/data', at: AT }),
      '日志.zip'
    )
  })

  test('单选同名归档 → 加时间戳岔开（否则会撞上"归档装在被打包内容里"）', async () => {
    const { defaultArchiveName } = await load()
    assert.equal(
      defaultArchiveName({ names: ['logs.tar.gz'], kind: 'tar.gz', dirName: '/srv', at: AT }),
      'logs-1030-123456.tar.gz'
    )
    assert.equal(
      defaultArchiveName({ names: ['logs.zip'], kind: 'zip', dirName: '/srv', at: AT }),
      'logs-1030-123456.zip'
    )
    // 换成另一种格式就不冲突，不该多塞时间戳
    assert.equal(
      defaultArchiveName({ names: ['logs.zip'], kind: 'tar.gz', dirName: '/srv', at: AT }),
      'logs.zip.tar.gz'
    )
  })

  test('产出名已经是另一个选中项 → 同样岔开', async () => {
    const { defaultArchiveName } = await load()
    const r = defaultArchiveName({
      names: ['a.txt.tar.gz', 'a.txt'],
      kind: 'tar.gz',
      dirName: '/srv',
      at: AT
    })
    // 多选走目录名分支，不会拿 a.txt 的名字去撞 a.txt.tar.gz
    assert.match(r, /1030-123456\.tar\.gz$/)
  })

  test('多选 → 目录名 + 个数 + 时间戳，不用第一个文件名冒充整包', async () => {
    const { defaultArchiveName } = await load()
    assert.equal(
      defaultArchiveName({ names: ['a', 'b', 'c'], kind: 'zip', dirName: '/srv/我的 目录', at: AT }),
      '我的 目录-3-1030-123456.zip'
    )
  })

  test('拿不到目录名时用 archive 兜底，空名不掺进来', async () => {
    const { defaultArchiveName } = await load()
    assert.match(
      defaultArchiveName({ names: ['a', 'b'], kind: 'tar.gz', at: AT }),
      /^archive-2-\d{4}-\d{6}\.tar\.gz$/
    )
    assert.match(
      defaultArchiveName({ names: ['a', '', null, 'b'], kind: 'tar.gz', dirName: '/', at: AT }),
      /^archive-2-\d{4}-\d{6}\.tar\.gz$/
    )
  })
})

describe('remote-archive 渲染层：名字与格式对齐', () => {
  test('换格式换的是后缀，不是再叠一层', async () => {
    const { alignArchiveName } = await load()
    assert.equal(alignArchiveName('app.js', 'tar.gz'), 'app.js.tar.gz')
    assert.equal(alignArchiveName('app.js', 'zip'), 'app.js.zip')
    assert.equal(alignArchiveName('app.js.tar.gz', 'zip'), 'app.js.zip')
    assert.equal(alignArchiveName('日志.zip', 'tar.gz'), '日志.tar.gz')
    // .tgz 归一成 .tar.gz：远端认两种，但界面只承诺一种
    assert.equal(alignArchiveName('日志.tgz', 'tar.gz'), '日志.tar.gz')
    assert.equal(alignArchiveName('  数据 包  ', 'zip'), '数据 包.zip')
    assert.equal(alignArchiveName('', 'zip'), '')
    // 只有真在末尾的后缀才算数
    assert.equal(alignArchiveName('a.zip.bak', 'zip'), 'a.zip.bak.zip')
  })

  test('空名与带分隔符的名字在这里就拦掉', async () => {
    const { archiveNameProblem } = await load()
    assert.equal(archiveNameProblem(''), 'empty')
    assert.equal(archiveNameProblem('   '), 'empty')
    assert.equal(archiveNameProblem('a/b'), 'badChar')
    assert.equal(archiveNameProblem('a\\b'), 'badChar')
    assert.equal(archiveNameProblem('a\nb'), 'badChar')
    assert.equal(archiveNameProblem('.'), 'badChar')
    assert.equal(archiveNameProblem('..'), 'badChar')
    assert.equal(archiveNameProblem('a b.tar.gz'), '')
    assert.equal(archiveNameProblem('-weird.zip'), '')
  })
})

// 契约读源码而非渲染组件（同 file-preview.spec.js 的思路）：
// 漏挂 Modal / 漏加 keys 清单 / 菜单入口判据写错，这类问题不需要 jsdom 也照样致命
describe('G4 归档接线契约', () => {
  const ROOT = path.join(__dirname, '../../..')
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
  const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  const APP_KEYS = 'src/app/common/constants.js'
  const CLIENT_KEYS = 'src/client/common/constants.js'
  const SFTP_SESSION = 'src/app/server/session-sftp.js'
  const ITEM = 'src/client/components/sftp/file-item.jsx'
  const MODAL = 'src/client/components/sftp/remote-archive-modal.jsx'
  const MAIN = 'src/client/components/main/main.jsx'
  const LOCALES = 'src/app/common/locales-extra.js'
  const ICONS = 'src/client/components/sys-menu/icons-map.jsx'
  const PURE = 'src/app/common/remote-archive.js'

  const ops = ['archiveCreate', 'archiveList', 'archiveExtract']

  test('三个方法进两侧 keys 清单，主进程也有对应方法（缺一条渲染层就调不到）', async () => {
    for (const p of [APP_KEYS, CLIENT_KEYS]) {
      const src = read(p)
      const block = src.slice(src.indexOf('instSftpKeys'))
      for (const k of ops) {
        assert.ok(block.includes("'" + k + "'"), p + ' 缺 ' + k)
      }
    }
    const sess = codeOf(read(SFTP_SESSION))
    for (const k of ops) {
      assert.match(sess, new RegExp(k + ' \\(opts\\) \\{'), k + ' 没接到 session-archive')
      assert.match(sess, new RegExp('sessionArchive\\.' + k + '\\(this, opts\\)'))
    }
  })

  test('打包入口只对远程、有 exec 通道、非 FTP 的真实文件出现', () => {
    const src = codeOf(read(ITEM))
    assert.match(src, /archiveFiles = \(\) => \{/)
    assert.match(src, /extractArchive = \(\) => \{/)
    assert.match(src, /refsStatic\.get\('remote-archive-modal'\)\?\.showCreate\(/)
    assert.match(src, /refsStatic\.get\('remote-archive-modal'\)\?\.showExtract\(/)
    // 判据与 gotoFolderInTerminal 同源：enableSsh !== false + !isFtp
    const gate = src.slice(src.indexOf('const canArchive'), src.indexOf("func: 'archiveFiles'"))
    assert.match(gate, /isRemote/)
    assert.match(gate, /hasHost/)
    assert.match(gate, /enableSsh !== false/)
    assert.match(gate, /!this\.props\.isFtp/)
    // 解压入口只给认得出后缀的非目录项
    assert.match(src, /!isDirectory && isArchiveName\(name\)/)
    // 完成后刷新远程列表，否则用户看不见刚生成的文件
    assert.match(src, /onDone: \(\) => this\.props\.remoteList\(\)/)
  })

  test('图标表里有两个新图标，否则菜单渲染出 undefined', () => {
    const src = read(ICONS)
    for (const ic of ['FileZipOutlined', 'FolderOpenOutlined']) {
      assert.equal((src.match(new RegExp('\\b' + ic + '\\b', 'g')) || []).length, 2, ic + ' 要 import + 导出各一处')
    }
  })

  test('Modal 挂到主界面（漏挂 = 点了没反应）', () => {
    const src = read(MAIN)
    assert.match(src, /import RemoteArchiveModal from '\.\.\/sftp\/remote-archive-modal'/)
    assert.match(src, /<RemoteArchiveModal \/>/)
  })

  test('弹层用三个归档接口，解压按钮在清单回来前不可点，且不提供取消', () => {
    const src = codeOf(read(MODAL))
    for (const k of ops) {
      assert.match(src, new RegExp('sftp\\.' + k + '\\('), k + ' 没被弹层调用')
    }
    assert.match(src, /disabled=\{!listing \|\| listingLoading \|\| !destDir\}/)
    // 假取消按钮会让用户以为远端停下来了：执行中的页脚连关闭都不该给
    const runningBlock = src.slice(src.indexOf('if (running)'), src.indexOf('if (mode === '))
    assert.ok(runningBlock.includes('if (running)'), '页脚少了执行中分支')
    assert.ok(!runningBlock.includes('this.handleClose'), '执行期间不该有能点的取消/关闭')
    assert.match(src, /seq !== this\.seq/)
    // 「生成到」那行提示必须与真正发出去的 dest 同源，否则提示会撒谎
    assert.match(src, /const dest = resolve\(dir, alignArchiveName\(name, kind\)\)/)
    assert.match(src, /\{resolve\(dir, alignArchiveName\(name, kind\)\)\}/)
    assert.match(src, /refsStatic\.add\('remote-archive-modal', this\)/)
    // 纯模块返回的问题码与这里的分支是同一份枚举，改一处要改两处
    assert.match(src, /problem === 'empty'/)
    assert.match(src, /problem === 'badChar'/)
    // 路径原文只进文本节点，不拼 HTML
    assert.ok(!/dangerouslySetInnerHTML/.test(src))
  })

  test('词条 en + zh 各一条且都用上了', () => {
    const locales = read(LOCALES)
    const used = codeOf(read(MODAL)) + codeOf(read(ITEM))
    for (const k of [
      'remoteArchivePack', 'remoteArchiveExtract', 'remoteArchivePackTitle',
      'remoteArchiveExtractTitle', 'remoteArchivePackBtn', 'remoteArchiveExtractBtn',
      'remoteArchiveKind', 'remoteArchiveDest', 'remoteArchiveFile', 'remoteArchiveExtractTo',
      'remoteArchiveSources', 'remoteArchiveListing', 'remoteArchiveTruncated',
      'remoteArchiveRunning', 'remoteArchiveCreated', 'remoteArchiveExtracted',
      'remoteArchiveNameEmpty', 'remoteArchiveNameBadChar'
    ]) {
      assert.equal((locales.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 2, k + ' 要 en + zh 各一条')
      assert.ok(new RegExp("e\\('" + k + "'\\)").test(used), k + ' 没被用上')
    }
    // 降级提示的 key 由主进程给出，渲染层按 key 取词
    assert.match(read(PURE), /noticeKey: 'remoteArchiveNoZip'/)
    assert.ok(/e\(result\.noticeKey\)/.test(codeOf(read(MODAL))))
    assert.equal((locales.match(/\bremoteArchiveNoZip:/g) || []).length, 2)
  })
})
