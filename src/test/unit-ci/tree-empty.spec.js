// T5-5a 书签树空态契约守护
// 拦截：空态分支丢失(回退白板)、文案 key 错位、SVG 硬编码色值、
//       设置页(staticList)误显示操作按钮、header 被空态替换
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const clientRoot = path.resolve(__dirname, '../../client')
const read = p => fs.readFileSync(path.join(clientRoot, p), 'utf8')

const listJsx = read('components/tree-list/tree-list.jsx')
const listStyl = read('components/tree-list/tree-list.styl')

describe('tree-empty: 空态分支契约 (tree-list.jsx)', () => {
  it('render 内判定空态: 搜索无结果(search) / 无任何书签(new)', () => {
    assert.match(listJsx, /const emptyType = keyword && !rows\.length/,
      '缺少搜索无结果判定')
    assert.match(listJsx, /!keyword && !\(this\.props\.bookmarks \|\| \[\]\)\.length \? 'new' : null/,
      '缺少无书签判定')
  })

  it('空态只替换树区, header(搜索框/工具条)保持渲染', () => {
    // header 必须无条件渲染 (清空搜索的入口不能随空态一起消失)
    const renderBody = listJsx.slice(listJsx.indexOf('  render () {'))
    assert.match(renderBody, /this\.renderSearch\(\)/)
    assert.match(renderBody, /emptyType\s*\?\s*this\.renderEmpty\(emptyType\)\s*:\s*this\.renderVirtualTreeContent\(rows, editor\)/,
      '树区必须按 emptyType 条件切换')
    assert.match(renderBody, /emptyType\s*\?\s*null\s*:\s*this\.renderEditorOverlay/,
      '空态时不得渲染编辑浮层')
    // 反向: renderSearch 不在条件分支内 (上方断言已保证三元仅包裹树区/浮层,
    // 此处反向确认 header 段不含 emptyType)
    const headerIdx = renderBody.indexOf('tree-list-header')
    const headerSeg = renderBody.slice(headerIdx, renderBody.indexOf('item-list-wrap'))
    assert.ok(!headerSeg.includes('emptyType'), 'header 段不得含 emptyType 条件')
  })

  it('文案用 locales 既有 key: notFoundContent / new+bookmarks / importFromFile', () => {
    assert.match(listJsx, /e\('notFoundContent'\)/)
    assert.match(listJsx, /\$\{e\('new'\)\} \$\{e\('bookmarks'\)\}/)
    assert.match(listJsx, /e\('importFromFile'\)/)
    // 反向: 不得引入 locales 包不存在的 key (translate 缺 key 回退 key 名)
    const keys = [...listJsx.matchAll(/e\('([a-zA-Z0-9]+)'\)/g)].map(m => m[1])
    const known = new Set([
      'notFoundContent', 'new', 'bookmarks', 'importFromFile',
      'edit', 'import', 'export', 'loadSshConfigs', 'bookmarkCategory',
      'title', 'host', 'category'
    ])
    const unknown = [...new Set(keys)].filter(k => !known.has(k))
    assert.deepEqual(unknown, [], `存在未确认的翻译 key: ${unknown.join(', ')}`)
  })

  it('设置页(staticList)只显示文案, 不渲染新建/导入按钮', () => {
    assert.match(listJsx, /type === 'new' && !staticList && \(/,
      '空态按钮必须带 staticList 守卫')
  })

  it('导入按钮复用 toolbar 隐藏上传入口 (与 handleExport 同模式)', () => {
    assert.match(listJsx, /handleImportFromFile = \(\) => \{\s*\n\s*document\.querySelector\('\.upload-bookmark-icon'\)\?\.click\(\)/)
  })
})

describe('tree-empty: SVG 插画契约', () => {
  it('SVG 全部用 var() 取色, 不得硬编码色值 (深浅主题自适应)', () => {
    const svgSeg = listJsx.slice(listJsx.indexOf('renderEmpty = type => {'), listJsx.indexOf('  render () {'))
    assert.ok(svgSeg.includes('<svg'), '空态 SVG 缺失')
    assert.doesNotMatch(svgSeg, /#[0-9a-fA-F]{3,8}/, 'SVG 内不得有裸 hex')
    assert.doesNotMatch(svgSeg, /rgba?\(/, 'SVG 内不得有 rgba/rgb')
    // 描边/填充色只用主题 token
    const colors = [...svgSeg.matchAll(/(?:stroke|fill)='(var\(--[a-z-]+\))'/g)].map(m => m[1])
    assert.ok(colors.length >= 4, 'SVG 描边/填充数量异常')
    for (const c of colors) {
      assert.match(c, /^var\(--(border-strong|text-dark|primary)\)$/,
        'SVG 用了非预期 token: ' + c)
    }
  })
})

describe('tree-empty: styl 契约 (tree-list.styl)', () => {
  it('空态容器/标题/按钮区样式存在', () => {
    assert.match(listStyl, /^\.tree-empty$/m)
    assert.match(listStyl, /^\.tree-empty-title$/m)
    assert.match(listStyl, /^\.tree-empty-btns$/m)
    assert.match(listStyl, /^\.tree-empty-icon$/m)
  })

  it('标题色用 token, 不得硬编码', () => {
    const seg = listStyl.slice(listStyl.indexOf('.tree-empty-title'), listStyl.indexOf('.tree-empty-btns'))
    assert.match(seg, /color var\(--text-dark\)/)
    assert.doesNotMatch(seg, /#[0-9a-fA-F]{3,8}/)
  })
})
