// 书签导入按钮 hover 说明契约
//  - 导入按钮（bookmark-toolbar.jsx / bookmark-transport.jsx 共用 .upload-bookmark-icon 入口）
//    的 title 必须用 locales-extra 的 importFormatsSupported 词条，
//    明确列出 bookmark-upload.js 分流支持的三种格式：
//    electerm 书签 JSON / Navicat .ncx / DBeaver data-sources.json
//  - 拦截：词条被改回单语 importFromFile、en/zh 词条缺失、格式清单遗漏
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')
const TOOLBAR = path.join(ROOT, 'src/client/components/tree-list/bookmark-toolbar.jsx')
const TRANSPORT = path.join(ROOT, 'src/client/components/tree-list/bookmark-transport.jsx')

// 源码求值拿词条（与仓库 vm 惯例一致，不做纯文本解析）
function loadLocalesExtra () {
  const code = fs.readFileSync(LOCALES, 'utf8')
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: LOCALES })
  return sandbox.module.exports
}

describe('bookmark-import-tip: 词条契约 (locales-extra.js)', () => {
  const locales = loadLocalesExtra()
  const KEY = 'importFormatsSupported'

  it('en 与 zh_cn 都定义了 importFormatsSupported', () => {
    assert.equal(typeof locales.en[KEY], 'string', 'en 缺少 ' + KEY)
    assert.equal(typeof locales.zh_cn[KEY], 'string', 'zh_cn 缺少 ' + KEY)
    assert.ok(locales.en[KEY].length > 0, 'en 词条为空')
    assert.ok(locales.zh_cn[KEY].length > 0, 'zh_cn 词条为空')
  })

  it('词条覆盖三种导入格式: electerm JSON / Navicat .ncx / DBeaver data-sources.json', () => {
    const expect = {
      en: [/electerm bookmarks JSON/, /Navicat \.ncx/, /DBeaver data-sources\.json/],
      zh_cn: [/electerm 书签 JSON/, /Navicat \.ncx/, /DBeaver data-sources\.json/]
    }
    for (const lang of Object.keys(expect)) {
      const text = locales[lang][KEY]
      for (const re of expect[lang]) {
        assert.match(text, re, `${lang} 词条缺格式说明: ${re}`)
      }
    }
  })

  it('词条格式清单与 bookmark-upload.js 分流能力一致 (回归防漂移)', () => {
    // bookmark-upload.js: .ncx → parseNcx；JSON → DBeaver 形状判定 → electerm 导出形状
    const uploadJs = fs.readFileSync(
      path.join(ROOT, 'src/client/components/tree-list/bookmark-upload.js'),
      'utf8'
    )
    assert.match(uploadJs, /parseNcx/, '分流实现变了请同步词条与测试')
    assert.match(uploadJs, /parseDbeaverDataSources/, '分流实现变了请同步词条与测试')
    assert.match(uploadJs, /bookmarkGroups/, '分流实现变了请同步词条与测试')
  })
})

describe('bookmark-import-tip: 按钮提示契约', () => {
  const toolbar = fs.readFileSync(TOOLBAR, 'utf8')
  const transport = fs.readFileSync(TRANSPORT, 'utf8')

  it('bookmark-toolbar.jsx 导入按钮 title 用 importFormatsSupported', () => {
    // 定位 .upload-bookmark-icon 的 Upload 块内的 Button
    const idx = toolbar.indexOf("className='upload-bookmark-icon'")
    assert.ok(idx > 0, '找不到 upload-bookmark-icon 入口')
    const seg = toolbar.slice(idx, idx + 400)
    assert.match(seg, /title=\{e\('importFormatsSupported'\)\}/,
      '导入按钮 title 应使用 importFormatsSupported 词条')
    assert.ok(!seg.includes('importFromFile'),
      '导入按钮不得回退到不含格式说明的 importFromFile')
  })

  it('bookmark-transport.jsx renderImport title 用 importFormatsSupported', () => {
    const idx = transport.indexOf("className='upload-bookmark-icon'")
    assert.ok(idx > 0, '找不到 upload-bookmark-icon 入口')
    const seg = transport.slice(idx, idx + 400)
    assert.match(seg, /title=\{e\('importFormatsSupported'\)\}/,
      '导入按钮 title 应使用 importFormatsSupported 词条')
    assert.ok(!seg.includes('importFromFile'),
      '导入按钮不得回退到不含格式说明的 importFromFile')
  })

  it('词条文件其余 importFromFile 用法不受影响 (其它导入入口不误伤)', () => {
    // tree-list.jsx 空态导入按钮仍用 importFromFile (tree-empty.spec.js 依赖)
    const listJsx = fs.readFileSync(
      path.join(ROOT, 'src/client/components/tree-list/tree-list.jsx'),
      'utf8'
    )
    assert.match(listJsx, /e\('importFromFile'\)/,
      'tree-list.jsx 的 importFromFile 用法不得被顺带改动')
  })
})
