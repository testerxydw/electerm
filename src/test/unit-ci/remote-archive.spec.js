const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const {
  NO_ZIP_MARKER,
  LIST_MAX_ENTRIES,
  escapePosixPath,
  splitPath,
  joinPath,
  archiveKindFromName,
  defaultArchivePath,
  planArchiveCreate,
  planArchiveList,
  planArchiveExtract,
  parseArchiveListing
} = require('../../app/common/remote-archive')

const b64 = (str) => Buffer.from(str, 'utf8').toString('base64')

// 独立复算一遍 base64 模板，命令串的形状被钉死在这里（同 session-sftp-remote-command）
const winCmd = (paths, script) => {
  const decoders = paths
    .map((p, i) => `$p${i}=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(p)}'))`)
    .join(';')
  return `powershell.exe -NoLogo -NonInteractive -NoProfile -Command "${decoders};${script}"`
}

// 文件名是远端目录列表里读出来的，属于不可信输入
const hostile = [
  '$(whoami)',
  '`id`',
  'a"b',
  "a'b",
  'a\\b',
  'a;b&c|d',
  '-weird.tar',
  '--help',
  '含 中文.txt',
  'a b.txt'
]

describe('remote-archive: 路径拆分', () => {
  test('posix 绝对路径拆成目录与 basename', () => {
    assert.deepEqual(splitPath('/srv/data/a.txt', 'p'), { dir: '/srv/data', base: 'a.txt' })
    assert.deepEqual(splitPath('/a.txt', 'p'), { dir: '/', base: 'a.txt' })
    assert.deepEqual(splitPath('/srv/含 中文/a.txt', 'p'), { dir: '/srv/含 中文', base: 'a.txt' })
  })

  test('windows：两种分隔符都认；posix：反斜杠只是普通字符', () => {
    assert.deepEqual(splitPath('C:\\data\\a.txt', 'p', 'windows'), { dir: 'C:\\data', base: 'a.txt' })
    assert.deepEqual(splitPath('C:\\a.txt', 'p', 'windows'), { dir: 'C:\\', base: 'a.txt' })
    // SFTP 列出来的远端 Windows 路径常用正斜杠
    assert.deepEqual(splitPath('D:/tmp/a.txt', 'p', 'windows'), { dir: 'D:/tmp', base: 'a.txt' })
    // posix 下 a\b 是一个名字，不能当成两级路径拆，否则 tar 的 -C 会 chdir 失败
    assert.deepEqual(splitPath('/srv/data/a\\b', 'p', 'posix'), { dir: '/srv/data', base: 'a\\b' })
  })

  test('拒绝：空、相对、结尾分隔符、点条目、换行', () => {
    assert.throws(() => splitPath('', 'p'), /non-empty/)
    assert.throws(() => splitPath('a.txt', 'p'), /absolute/)
    assert.throws(() => splitPath('/srv/data/', 'p'), /separator/)
    assert.throws(() => splitPath('/srv/.', 'p'), /dot entry/)
    assert.throws(() => splitPath('/srv/..', 'p'), /dot entry/)
    assert.throws(() => splitPath('/srv/a\nb', 'p'), /newline/)
    assert.throws(() => splitPath('/srv/a\rb', 'p'), /newline/)
    assert.throws(() => splitPath('C:\\srv\\a.txt', 'p', 'posix'), /absolute/)
  })

  test('joinPath 不在根目录后叠分隔符', () => {
    assert.equal(joinPath('/srv', 'x.tar.gz'), '/srv/x.tar.gz')
    assert.equal(joinPath('/', 'x.tar.gz'), '/x.tar.gz')
    assert.equal(joinPath('C:\\', 'x.zip'), 'C:\\x.zip')
    assert.equal(joinPath('D:/tmp', 'x.zip'), 'D:/tmp/x.zip')
  })
})

describe('remote-archive: 认类型与默认落点', () => {
  test('后缀 → 类型', () => {
    assert.equal(archiveKindFromName('a.tar.gz'), 'tar-gz')
    assert.equal(archiveKindFromName('A.TGZ'), 'tar-gz')
    assert.equal(archiveKindFromName('a.tar'), 'tar')
    assert.equal(archiveKindFromName('a.zip'), 'zip')
    assert.equal(archiveKindFromName('a.txt'), null)
    assert.equal(archiveKindFromName(''), null)
  })

  test('默认落点 = 所在目录 + 首个名字 + 后缀', () => {
    assert.equal(
      defaultArchivePath({ sources: ['/srv/data/logs', '/srv/data/app'], kind: 'tar.gz' }),
      '/srv/data/logs.tar.gz'
    )
    assert.equal(
      defaultArchivePath({ sources: ['/srv/data/logs.zip'], kind: 'zip' }),
      '/srv/data/logs.zip'
    )
    assert.equal(
      defaultArchivePath({ sources: ['C:\\data\\日志'], kind: 'zip', platform: 'windows' }),
      'C:\\data\\日志.zip'
    )
    // posix 侧 `\` 是普通字符，落点仍在同一个目录里
    assert.equal(
      defaultArchivePath({ sources: ['/srv/a\\b'], kind: 'tar.gz', platform: 'posix' }),
      '/srv/a\\b.tar.gz'
    )
    assert.throws(() => defaultArchivePath({ sources: [], kind: 'zip' }), /non-empty array/)
  })
})

describe('remote-archive: 打包命令', () => {
  test('tar.gz：-C 父目录 + -- + basename', () => {
    const r = planArchiveCreate({
      kind: 'tar.gz',
      sources: ['/srv/data/a.txt', '/srv/data/b 目录'],
      dest: '/srv/data/out.tar.gz'
    })
    assert.equal(r.cmd, 'tar -czf "/srv/data/out.tar.gz" -C "/srv/data" -- "a.txt" "b 目录"')
    assert.equal(r.producedPath, '/srv/data/out.tar.gz')
    assert.equal(r.fallback, null)
  })

  test('zip：先 command -v，缺 zip 整包降级 tar.gz 并打标记', () => {
    const r = planArchiveCreate({
      kind: 'zip',
      sources: ['/srv/data/a.txt'],
      dest: '/srv/data/out.zip'
    })
    assert.equal(
      r.cmd,
      'if command -v zip >/dev/null 2>&1; then cd "/srv/data" && zip -q -r "/srv/data/out.zip" "./a.txt"; ' +
      `else tar -czf "/srv/data/out.tar.gz" -C "/srv/data" -- "a.txt" && echo ${NO_ZIP_MARKER}; fi`
    )
    assert.equal(r.fallback.producedPath, '/srv/data/out.tar.gz')
    assert.equal(r.fallback.marker, NO_ZIP_MARKER)
    assert.equal(r.producedPath, '/srv/data/out.zip')
  })

  test('zip 成员用 ./ 前缀：Info-ZIP 3.0 不认 --（实测 can\'t use -- before archive name），前缀才挡得住 -weird', () => {
    const r = planArchiveCreate({
      kind: 'zip',
      sources: ['/srv/-weird.tar', '/srv/--help'],
      dest: '/srv/out.zip'
    })
    const thenBranch = r.cmd.split('; then ')[1].split('; else')[0]
    assert.equal(thenBranch, 'cd "/srv" && zip -q -r "/srv/out.zip" "./-weird.tar" "./--help"')
  })

  test('hostile 名字：tar 支的形状 = 模板 + 转义引号串，一个字符都不多', () => {
    for (const name of hostile) {
      const r = planArchiveCreate({
        kind: 'tar.gz',
        sources: [`/srv/data/${name}`],
        dest: '/srv/data/out.tar.gz'
      })
      assert.equal(
        r.cmd,
        `tar -czf "/srv/data/out.tar.gz" -C "/srv/data" -- ${escapePosixPath(name)}`
      )
      // 成员段整体就是引号串：$ ` \ " 全在引号里带反斜杠，不会被 shell 当语法
      assert.ok(r.cmd.endsWith(`-- ${escapePosixPath(name)}`))
    }
  })

  test('hostile 名字：Windows 支的形状 = 模板 + base64，命令行里看不到原名', () => {
    const script = '$ErrorActionPreference=\'Stop\';$a=@($p2);& tar -czf $p0 -C $p1 -- $a;exit $LASTEXITCODE'
    const lastSep = (s) => Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    for (const name of hostile) {
      const src = `C:\\data\\${name}`
      const i = lastSep(src)
      const r = planArchiveCreate({
        platform: 'windows',
        kind: 'tar.gz',
        sources: [src],
        dest: 'C:\\data\\out.tar.gz'
      })
      // 期望：$p0=dest、$p1=父目录、$p2=成员名，全都只以 base64 出现在命令行上
      assert.equal(
        r.cmd,
        winCmd(['C:\\data\\out.tar.gz', src.slice(0, i), src.slice(i + 1)], script)
      )
    }
  })

  test('windows zip 走 Compress-Archive，tar.gz 走 tar 并显式回传退出码', () => {
    const z = planArchiveCreate({
      platform: 'windows',
      kind: 'zip',
      sources: ['C:\\data\\a.txt', 'C:\\data\\日志'],
      dest: 'C:\\data\\out.zip'
    })
    assert.equal(
      z.cmd,
      winCmd(
        ['C:\\data\\out.zip', 'a.txt', '日志'],
        'Compress-Archive -LiteralPath $p1,$p2 -DestinationPath $p0 -Force'
      )
    )
    const t = planArchiveCreate({
      platform: 'windows',
      kind: 'tar.gz',
      sources: ['C:\\data\\a.txt'],
      dest: 'C:\\data\\out.tar.gz'
    })
    assert.equal(
      t.cmd,
      winCmd(
        ['C:\\data\\out.tar.gz', 'C:\\data', 'a.txt'],
        '$ErrorActionPreference=\'Stop\';$a=@($p2);& tar -czf $p0 -C $p1 -- $a;exit $LASTEXITCODE'
      )
    )
  })

  test('拒绝：跨目录的源、空源、未知 kind、非绝对 dest', () => {
    assert.throws(
      () => planArchiveCreate({ kind: 'tar.gz', sources: ['/a/x', '/b/y'], dest: '/a/o.tar.gz' }),
      /same directory/
    )
    assert.throws(() => planArchiveCreate({ kind: 'tar.gz', sources: [], dest: '/a/o.tar.gz' }), /non-empty array/)
    assert.throws(() => planArchiveCreate({ kind: '7z', sources: ['/a/x'], dest: '/a/o.7z' }), /unsupported archive kind/)
    assert.throws(() => planArchiveCreate({ kind: 'tar.gz', sources: ['/a/x'], dest: 'o.tar.gz' }), /absolute/)
    assert.throws(() => planArchiveCreate({ kind: 'tar.gz', sources: ['/a/x'], dest: '' }), /non-empty/)
  })

  test('拒绝：zip 落点后缀不对（回退名靠 .zip 换出来，后缀是契约）', () => {
    assert.throws(
      () => planArchiveCreate({ kind: 'zip', sources: ['/a/x'], dest: '/a/o.tar.gz' }),
      /must end with \.zip/
    )
    assert.throws(
      () => planArchiveCreate({ platform: 'windows', kind: 'zip', sources: ['C:\\a\\x'], dest: 'C:\\a\\o' }),
      /must end with \.zip/
    )
  })

  test('拒绝：归档写进被打包的目录里（tar 会 not dumped）', () => {
    assert.throws(
      () => planArchiveCreate({ kind: 'tar.gz', sources: ['/srv/data'], dest: '/srv/data/out.tar.gz' }),
      /inside a source/
    )
    assert.throws(
      () => planArchiveCreate({ kind: 'tar.gz', sources: ['/srv/data'], dest: '/srv/data' }),
      /not be one of the sources/
    )
    assert.throws(
      () => planArchiveCreate({ kind: 'tar.gz', sources: ['/srv/data\n'], dest: '/srv/data\n/x.tar.gz' }),
      /newline/
    )
  })

  test('分隔符混用的同源判定（C:\\a 与 C:/a 算同一目录）', () => {
    const r = planArchiveCreate({
      platform: 'windows',
      kind: 'tar.gz',
      sources: ['C:\\data\\a', 'C:/data/b'],
      dest: 'C:\\data\\o.tar.gz'
    })
    assert.ok(r.cmd.length > 0)
  })
})

describe('remote-archive: 清单命令与解析', () => {
  test('按后缀选 tar / unzip', () => {
    assert.equal(planArchiveList({ archivePath: '/a/o.tar.gz' }).cmd, 'tar -tzf "/a/o.tar.gz"')
    assert.equal(planArchiveList({ archivePath: '/a/o.tgz' }).cmd, 'tar -tzf "/a/o.tgz"')
    assert.equal(planArchiveList({ archivePath: '/a/o.tar' }).cmd, 'tar -tf "/a/o.tar"')
    assert.equal(planArchiveList({ archivePath: '/a/o.zip' }).cmd, 'unzip -Z1 "/a/o.zip"')
    assert.equal(planArchiveList({ archivePath: '/a/o.zip' }).kind, 'zip')
    assert.throws(() => planArchiveList({ archivePath: '/a/o.txt' }), /unsupported archive type/)
  })

  test('windows：zip 用 ZipFile 枚举，tar 用 tar -tf', () => {
    const z = planArchiveList({ platform: 'windows', archivePath: 'C:\\a\\o.zip' })
    assert.ok(z.cmd.startsWith('powershell.exe'))
    assert.ok(z.cmd.includes(b64('C:\\a\\o.zip')))
    assert.ok(z.cmd.includes('System.IO.Compression.ZipFile'))
    const t = planArchiveList({ platform: 'windows', archivePath: 'C:\\a\\o.tar.gz' })
    assert.ok(t.cmd.includes('& tar -tzf $p0;exit $LASTEXITCODE'))
  })

  test('解析：CRLF、空行、尾部空白、目录条目、上限截断', () => {
    // 前导空格保留：' README' 是合法文件名，清掉等于少报一个
    const r = parseArchiveListing('a/\r\na/b.txt\r\n\r\n c.txt \r\n')
    assert.deepEqual(r.entries, ['a/b.txt', ' c.txt'])
    assert.equal(r.total, 2)
    assert.equal(r.truncated, false)

    const many = new Array(LIST_MAX_ENTRIES + 5).fill(0).map((_, i) => `f${i}`).join('\n')
    const big = parseArchiveListing(many)
    assert.equal(big.entries.length, LIST_MAX_ENTRIES)
    assert.equal(big.total, LIST_MAX_ENTRIES + 5)
    assert.equal(big.truncated, true)

    assert.deepEqual(parseArchiveListing('').entries, [])
    // 反斜杠结尾是 posix 合法文件名，不能当目录条目滤掉
    assert.deepEqual(parseArchiveListing('a\\\nb').entries, ['a\\', 'b'])
  })
})

describe('remote-archive: 解压命令', () => {
  test('tar 一律 -C，unzip 一律 -d 且 -o 不询问', () => {
    assert.equal(
      planArchiveExtract({ archivePath: '/a/o.tar.gz', destDir: '/srv/data' }).cmd,
      'tar -xf "/a/o.tar.gz" -C "/srv/data"'
    )
    assert.equal(
      planArchiveExtract({ archivePath: '/a/o.zip', destDir: '/srv/含 中文' }).cmd,
      'unzip -q -o "/a/o.zip" -d "/srv/含 中文"'
    )
    assert.equal(planArchiveExtract({ archivePath: '/a/o.tar', destDir: '/srv' }).cmd, 'tar -xf "/a/o.tar" -C "/srv"')
  })

  test('windows：zip 用 Expand-Archive，tar 用 tar -xf 并回传退出码', () => {
    const z = planArchiveExtract({ platform: 'windows', archivePath: 'C:\\a\\o.zip', destDir: 'C:\\srv' })
    assert.equal(
      z.cmd,
      winCmd(['C:\\a\\o.zip', 'C:\\srv'], 'Expand-Archive -LiteralPath $p0 -DestinationPath $p1 -Force')
    )
    const t = planArchiveExtract({ platform: 'windows', archivePath: 'C:\\a\\o.tar.gz', destDir: 'C:\\srv' })
    assert.ok(t.cmd.includes('& tar -xf $p0 -C $p1;exit $LASTEXITCODE'))
  })

  test('拒绝：非归档类型、相对 destDir、带换行的路径', () => {
    assert.throws(() => planArchiveExtract({ archivePath: '/a/o.txt', destDir: '/srv' }), /unsupported archive type/)
    assert.throws(() => planArchiveExtract({ archivePath: '/a/o.zip', destDir: 'srv' }), /absolute/)
    assert.throws(() => planArchiveExtract({ archivePath: '/a/o.zip', destDir: '/sr\nv' }), /newline/)
  })
})
