/**
 * G3 远程文件预览：接线契约
 *
 * 纯函数与分片读在 remote-preview.spec.js 里跑真代码；这里钉的是"有没有被
 * 真接上"：两侧会话方法、两条 keys 清单、右键入口、Modal 挂载、渲染分支与
 * 词条。契约读源码而非渲染，避免为了测一个只读面板引入 jsdom 装配。
 */

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SSH_SESSION = 'src/app/server/session-sftp.js'
const FTP_SESSION = 'src/app/server/session-ftp.js'
const SSH_FILE = 'src/app/server/sftp-file.js'
const FTP_FILE = 'src/app/server/ftp-file.js'
const APP_KEYS = 'src/app/common/constants.js'
const CLIENT_KEYS = 'src/client/common/constants.js'
const ITEM = 'src/client/components/sftp/file-item.jsx'
const MODAL = 'src/client/components/sftp/file-preview-modal.jsx'
const MAIN = 'src/client/components/main/main.jsx'
const LOCALES = 'src/app/common/locales-extra.js'
const ICONS = 'src/client/components/sys-menu/icons-map.jsx'

// 去掉行注释：契约钉代码，不钉注释
const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

describe('G3: 分片读与 stat 两侧都在', () => {
  test('SFTP 侧：chunk 用 start/end 建流，stat 归一成 { size, mtime, mode, isDirectory }', () => {
    const src = codeOf(read(SSH_FILE))
    assert.match(src, /function readRemoteFileChunk \(sftp, path, start = 0, end = 0\)/)
    assert.match(src, /createReadStream\(path, \{[\s\S]*?start,[\s\S]*?end,/)
    assert.match(src, /function statRemoteFile \(sftp, path\)/)
    assert.match(src, /isDirectory: \(mode & 0o170000\) === 0o040000/)
    // 源流报错必须 settle，否则大文件预览会挂住
    assert.match(src, /readStream\.on\('error'/)
  })

  test('SFTP 预览：mtime 秒 → 毫秒，读多少由 previewReadLimit 决定', () => {
    const src = codeOf(read(SSH_SESSION))
    assert.match(src, /const limit = previewReadLimit\(name, stats\.size\)/)
    assert.match(src, /readRemoteFileChunk\(this\.sftp, remotePath, 0, limit - 1\)/)
    assert.match(src, /mtime: stats\.mtime \* 1000/)
    assert.match(src, /buildPreview\(\{/)
    assert.match(src, /throw new Error\('preview target is a directory: ' \+ remotePath\)/)
  })

  test('FTP 预览：同一套上限与判定，chunk 带 start（REST）', () => {
    const src = codeOf(read(FTP_SESSION))
    assert.match(src, /async previewRemoteFile \(remotePath, client\)/)
    assert.match(src, /const limit = previewReadLimit\(name, stats\.size\)/)
    assert.match(src, /readRemoteFileChunk\(currentClient, remotePath, 0, limit - 1\)/)
    assert.match(src, /buildPreview\(\{/)
    const fileSrc = codeOf(read(FTP_FILE))
    assert.match(fileSrc, /function readRemoteFileChunk \(client, remotePath, start = 0, end = 0\)/)
    assert.match(fileSrc, /client\.downloadTo\(writable, remotePath, from\)/)
  })
})

describe('G3: 方法进两条 keys 清单（缺一条渲染层就调不到）', () => {
  const keys = ['readRemoteFileChunk', 'statRemoteFile', 'previewRemoteFile']
  test('主进程与渲染层份 const 清单都含三个新方法', () => {
    for (const p of [APP_KEYS, CLIENT_KEYS]) {
      const src = read(p)
      const block = src.slice(src.indexOf('instSftpKeys'))
      for (const k of keys) {
        assert.ok(block.includes("'" + k + "'"), p + ' 缺 ' + k)
      }
    }
  })

  test('主进程派发用同一份清单（不在别处另开白名单）', () => {
    const src = read('src/app/server/session-server.js')
    assert.match(src, /instSftpKeys\.includes\(func\)/)
  })
})

describe('G3: 入口与挂载', () => {
  test('远程文件右键有「预览」，本地不出现', () => {
    const src = codeOf(read(ITEM))
    assert.match(src, /previewFile = \(\) => \{/)
    assert.match(src, /refsStatic\.get\('file-preview-modal'\)\?\.showFilePreviewModal\(/)
    const block = src.slice(src.indexOf("func: 'previewFile'") - 200, src.indexOf("func: 'previewFile'") + 120)
    assert.match(block, /isRemote && isRealFile/, '预览入口只对远程真实文件出现')
  })

  test('图标表里有 EyeOutlined，否则菜单渲染出 undefined', () => {
    assert.match(read(ICONS), /\bEyeOutlined\b/)
  })

  test('Modal 挂到主界面（漏挂 = 点了没反应）', () => {
    const src = read(MAIN)
    assert.match(src, /import FilePreviewModal from '\.\.\/sftp\/file-preview-modal'/)
    assert.match(src, /<FilePreviewModal \/>/)
  })

  test('Modal 用远程预览接口，不退回全量 readFile', () => {
    const src = codeOf(read(MODAL))
    assert.match(src, /sftp\.previewRemoteFile\(path\)/)
    assert.ok(!/\.readFile\(/.test(src), '预览不该走全量 readFile')
    // 连续开多个文件时只认最后一个回包
    assert.match(src, /seq !== this\.seq/)
  })

  test('三种渲染分支 + 截断横幅带下载出口', () => {
    const src = codeOf(read(MODAL))
    assert.match(src, /data\.kind === 'image'/)
    assert.match(src, /data\.kind === 'binary'/)
    assert.match(src, /data:' \+ data\.mime \+ ';base64,/)
    assert.match(src, /data\.truncated/)
    assert.match(src, /onDownload/)
    // 查找高亮按文本切片拼节点，不走原始 HTML 注入
    assert.ok(!/dangerouslySetInnerHTML/.test(src))
    assert.match(src, /filePreviewFindCount/)
  })

  test('七个词条 en + zh 各一条且都用上了', () => {
    const locales = read(LOCALES)
    const used = codeOf(read(MODAL)) + codeOf(read(ITEM))
    for (const k of ['filePreview', 'filePreviewFind', 'filePreviewFindCount',
      'filePreviewTruncated', 'filePreviewBinary', 'filePreviewEmpty', 'filePreviewError']) {
      assert.equal((locales.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 2, k + ' 要 en + zh 各一条')
      assert.ok(new RegExp("e\\('" + k + "'\\)").test(used), k + ' 没被用上')
    }
  })
})
