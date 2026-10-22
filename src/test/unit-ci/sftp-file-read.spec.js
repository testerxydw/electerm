// F 批次：SFTP 路径解析纯函数覆盖
// 直接抽取 file-read.js 中的发布实现到 vm 执行，不复制逻辑
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const FILE_READ = path.join(ROOT, 'src/client/components/sftp/file-read.js')

function load () {
  const src = fs.readFileSync(FILE_READ, 'utf8')
  const pick = name => {
    const m = src.match(new RegExp('(?:export )?const ' + name + ' = [\\s\\S]*?\\n\\}'))
    assert.ok(m, name + ' definition not found')
    return m[0].replace(/^export /, '')
  }
  const code = [
    pick('getFileExt'),
    pick('toIsDirectory'),
    pick('getFolderFromFilePath')
  ].join('\n') + ';({ getFileExt, toIsDirectory, getFolderFromFilePath })'
  const make = (sep, win) => vm.runInNewContext(code, {
    window: { pre: { sep } },
    isWin: win,
    modeDirectoryMask: 0o170000,
    modeDirectoryValue: 0o040000
  })
  return { make }
}

// vm 上下文里的对象属于另一 realm，deepStrictEqual 会因原型不同判不等
const plain = o => JSON.parse(JSON.stringify(o))

describe('F：SFTP getFileExt', () => {
  const { getFileExt } = load().make('/', false)

  test('单扩展名 / 多扩展名 / 无扩展名', () => {
    assert.deepEqual(plain(getFileExt('a.txt')), { base: 'a', ext: 'txt' })
    assert.deepEqual(plain(getFileExt('a.tar.gz')), { base: 'a.tar', ext: 'gz' })
    assert.deepEqual(plain(getFileExt('noext')), { base: 'noext', ext: '' })
    assert.deepEqual(plain(getFileExt('trailing.')), { base: 'trailing', ext: '' })
  })

  test('点开头文件按现有实现拆成空 base', () => {
    assert.deepEqual(plain(getFileExt('.bashrc')), { base: '', ext: 'bashrc' })
  })

  test('Windows WSL UNC 路径整体视为 base', () => {
    const p = '\\\\wsl$\\Ubuntu\\home\\a.txt'
    assert.deepEqual(plain(getFileExt(p)), { base: p, ext: '' })
  })
})

describe('F：SFTP getFolderFromFilePath', () => {
  test('远端路径：目录 + 文件名 + 扩展名', () => {
    const { getFolderFromFilePath } = load().make('/', false)
    assert.deepEqual(
      plain(getFolderFromFilePath('/home/user/a.txt', true)),
      { path: '/home/user', name: 'a.txt', base: 'a', ext: 'txt' }
    )
    assert.deepEqual(
      plain(getFolderFromFilePath('/home/user/dir', true)),
      { path: '/home/user', name: 'dir', base: 'dir', ext: '' }
    )
  })

  test('本地 posix 路径', () => {
    const { getFolderFromFilePath } = load().make('/', false)
    assert.deepEqual(
      plain(getFolderFromFilePath('/tmp/a.log.gz', false)),
      { path: '/tmp', name: 'a.log.gz', base: 'a.log', ext: 'gz' }
    )
  })

  test('本地 Windows 路径使用反斜杠分隔', () => {
    const { getFolderFromFilePath } = load().make('\\', true)
    assert.deepEqual(
      plain(getFolderFromFilePath('C:\\tmp\\a.txt', false)),
      { path: 'C:\\tmp', name: 'a.txt', base: 'a', ext: 'txt' }
    )
  })
})

describe('F：SFTP toIsDirectory', () => {
  const { toIsDirectory } = load().make('/', false)

  test('兼容函数/布尔/字符串/数字 mode 四种 stat 形态', () => {
    assert.equal(toIsDirectory({ isDirectory: () => true }), true)
    assert.equal(toIsDirectory({ isDirectory: true }), true)
    assert.equal(toIsDirectory({ type: 'd' }), true)
    assert.equal(toIsDirectory({ type: 2 }), true)
    assert.equal(toIsDirectory({ mode: 0o040755 }), true)
    assert.equal(toIsDirectory({ mode: 0o100644 }), false)
    assert.equal(toIsDirectory(null), false)
  })
})
