// RDP 下载按钮灰色时的提示契约
// 灰是"远端还没复制文件"而非"功能坏了"，所以视觉态、hover 说明、点击反馈三者
// 必须同源；漏一个就退化成"点了没反应"，用户只能猜。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SESSION = 'src/client/components/rdp/rdp-session.jsx'
const TRANSFER = 'src/client/components/rdp/file-transfer.js'
const LOCALES = 'src/app/common/locales-extra.js'

const slice = (src, from, to) => {
  const s = src.indexOf(from)
  const e = src.indexOf(to, s)
  assert.ok(s > -1 && e > s, `取不到代码段：${from}`)
  return src.slice(s, e)
}

describe('RDP 下载：无远端文件时的提示接线', () => {
  const src = read(SESSION)

  test('点击在灰态给出可见提示，不再静默调 downloadFiles', () => {
    const body = slice(src, 'handleDownloadButtonClick = () => {', 'handlePasteEvent =')
    assert.ok(
      body.includes('if (!this.fileTransfer.hasRemoteFiles)'),
      '灰态分支缺失：判据要与 file-transfer 的门同源（hasRemoteFiles）'
    )
    assert.ok(body.includes('message.info(this.downloadHint()'), '灰态点击必须给出可见提示')
    const guard = body.indexOf('hasRemoteFiles)')
    const call = body.indexOf('this.fileTransfer.downloadFiles()')
    assert.ok(call > guard, '没有先挡住灰态就发起下载')
  })

  test('hover 与点击共用同一句提示文案', () => {
    const render = slice(src, 'const uploadTitle =', 'return (\n      <>\n        <ReloadOutlined')
    assert.ok(render.includes('hasRemoteFiles'), 'tooltip 未按灰/亮分流')
    assert.ok(render.includes('this.downloadHint()'), 'tooltip 没有复用提示方法')
    assert.ok(render.includes("window.translate('rdpDownloadCount')"), '亮态 tooltip 缺少文件数')
    assert.ok(
      render.includes("countTpl.replace('{n}', String(downloadCount))"),
      '文件数占位符没有真正替换'
    )
  })

  test('灰色样式仍绑 hasRemoteFiles，且由状态回调喂数', () => {
    const dlBtn = src.match(/<DownloadOutlined[\s\S]*?\/>/)
    assert.ok(dlBtn, '找不到下载按钮')
    assert.ok(dlBtn[0].includes('onClick={this.handleDownloadButtonClick}'), '下载按钮没接点击处理')
    assert.ok(dlBtn[0].includes('rdp-download-disabled'), '灰态样式类缺失')
    assert.ok(dlBtn[0].includes('rdp-download-flash'), '可用态样式类缺失')
    assert.ok(dlBtn[0].includes('hasRemoteFiles ?'), '灰态样式没有绑到 hasRemoteFiles')
    const cb = slice(src, 'setStateChangeCallback((state) => {', 'const fileTransferExtensions')
    assert.ok(cb.includes('hasRemoteFiles: state.hasRemoteFiles'), '状态回调漏了 hasRemoteFiles')
    assert.ok(cb.includes('downloadCount: state.pendingDownloads.size'), '状态回调漏了 downloadCount')
    assert.ok(!src.includes('downloadBtnDisabled'), '遗留了没人读的 downloadBtnDisabled 状态')
  })

  test('主逻辑侧的空清单门保持不变（点击不会发起空请求）', () => {
    const ft = read(TRANSFER)
    const dl = slice(ft, 'downloadFiles () {', 'formatFileSize (bytes)')
    assert.ok(dl.includes('if (this.pendingDownloads.size === 0)'), '空清单门被移除')
    const avail = slice(ft, 'createFilesAvailableCallback (Extension)', 'createFileContentsRequestCallback')
    assert.ok(avail.includes('this.hasRemoteFiles = files && files.length > 0'), 'hasRemoteFiles 没有由远端事件驱动')
  })

  test('提示文案要说出该做什么（复制文件），且中英各一份', () => {
    const extra = require(path.join(ROOT, LOCALES))
    const en = extra.en.rdpDownloadNeedsCopy
    const zh = extra.zh_cn.rdpDownloadNeedsCopy
    assert.ok(/copy/i.test(en), 'en 提示没说明"先复制文件"：' + en)
    assert.ok(en.includes('remote'), 'en 提示没点明是远程桌面：' + en)
    assert.ok(zh.includes('复制'), 'zh 提示没说明"先复制文件"：' + zh)
    assert.ok(zh.includes('远程'), 'zh 提示没点明是远程桌面：' + zh)
    assert.ok(extra.en.rdpDownloadCount.includes('{n}'), 'en 计数词条缺 {n}')
    assert.ok(extra.zh_cn.rdpDownloadCount.includes('{n}'), 'zh 计数词条缺 {n}')
    const keys = [...read(LOCALES).matchAll(/^\s{2}(rdpDownload[A-Za-z0-9]+):/gm)].map(m => m[1])
    const twice = [...new Set(keys)].filter(k => keys.filter(x => x === k).length === 2)
    assert.deepEqual(
      [...new Set(keys)].sort(),
      twice.sort(),
      'rdpDownload* 词条必须中英文各一处：' + keys.join(', ')
    )
  })
})
