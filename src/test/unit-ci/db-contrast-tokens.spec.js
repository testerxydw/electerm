// U2c 文字对比度 token 契约：弱化用 --text-muted、主色正文用 --primary-text
//
// 实测（self-test/db-contrast-demo.js，深/浅 × 卡片底/悬停底/选中底）改前：
//   · NULL 占位 opacity .5 → 2.21~4.21:1；空串占位 opacity .45 → 1.91~3.64:1
//   · --primary 直接当正文色 → 浅色主题卡片底 3.33:1（深色主题压进浸染底 4.06:1）
//   · 格内正文继承 antd 的 colorText（rgba(85,85,85,.88)）→ 浅色选中底 4.17:1
// 三条都不满足 WCAG AA 的 4.5:1。这里钉住"弱化只改颜色、不改不透明度"这套口径，
// 免得下次又有人用 opacity 去压已经达标的文字。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const STYL = 'src/client/components/database/db-session.styl'
const TOKENS = 'src/client/css/includes/tokens.styl'

const codeOf = src => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// 顶层规则体：从 ".name" 那行到下一个顶层选择器（或文件尾）
const ruleOf = (src, name) => {
  const start = src.indexOf('\n' + name + '\n')
  assert.notEqual(start, -1, name + ' 规则未找到')
  const rest = src.slice(start + 1)
  const m = /\n(?=[.#\w])/.exec(rest)
  return rest.slice(0, m ? m.index : rest.length)
}

describe('U2c 对比度 token 契约', () => {
  test('tokens.styl：--text-muted / --primary-text 由主题派生（不写死色值）', () => {
    const src = read(TOKENS)
    // 注意取 '\n.theme-light'：文件里第 40 行注释也提到 .theme-light，裸 indexOf 会截早
    const at = src.indexOf('\n.theme-light')
    assert.ok(at > 0)
    const root = src.slice(0, at)
    assert.match(root, /--text-muted unquote\('color-mix\(in srgb, var\(--text\) \d+%, var\(--main\)\)'\)/)
    assert.match(root, /--primary-text unquote\('color-mix\(in srgb, var\(--primary\) \d+%, var\(--text-light\)\)'\)/)
  })

  test('tokens.styl：浅色主题两个 token 都有覆盖，且"更弱"是更深而不是更浅', () => {
    const src = read(TOKENS)
    const light = src.slice(src.indexOf('\n.theme-light'))
    // 浅色下 --text 往 --main 收只会更淡（#555→#767676 只剩 3.9:1），所以取 --text-dark
    assert.match(light, /--text-muted var\(--text-dark\)/)
    assert.match(light, /--primary-text unquote\('color-mix\(in srgb, var\(--primary\) \d+%, #000000\)'\)/)
  })

  test('NULL / 空串占位改用 --text-muted，且不再带 opacity', () => {
    const src = codeOf(read(STYL))
    for (const name of ['.db-cell-null', '.db-cell-empty']) {
      const rule = ruleOf(src, name)
      assert.ok(rule.includes('color var(--text-muted)'), name + ' 应吃 --text-muted')
      assert.equal(/opacity/.test(rule), false, name + ' 不该再用 opacity 压对比度')
    }
  })

  test('行详情里的弱化文字同样走 --text-muted（字段名与 NULL 值）', () => {
    const src = codeOf(read(STYL))
    const type = ruleOf(src, '.db-row-detail-type')
    assert.ok(type.includes('color var(--text-muted)'))
    assert.equal(/opacity/.test(type), false)
    const detail = ruleOf(src, '.db-row-detail-value')
    assert.match(detail, /&\.is-null\n {4}color var\(--text-muted\)/)
    assert.equal(/&\.is-null\n[\s\S]{0,120}opacity/.test(detail), false, 'is-null 不该再用 opacity')
  })

  test('主色当正文色的两处（已选计数、执行计划类型）换成 --primary-text', () => {
    const src = codeOf(read(STYL))
    for (const name of ['.db-grid-selected', '.db-explain-type']) {
      const rule = ruleOf(src, name)
      assert.ok(rule.includes('color var(--primary-text)'), name + ' 应吃 --primary-text')
      assert.equal(rule.includes('color var(--primary)'), false, name + ' 仍在用裸 --primary 作正文色')
    }
  })

  test('格内正文显式用不透明 --text（不继承 antd 带 alpha 的 colorText）', () => {
    const src = codeOf(read(STYL))
    const start = src.indexOf('.db-grid-table\n  .ant-table .ant-table-tbody .ant-table-row > .ant-table-cell')
    assert.notEqual(start, -1, '格内正文那条规则未找到')
    const rule = src.slice(start, start + 260)
    assert.match(rule, /color var\(--text\)\n {4}transition background/)
  })

  test('唯一例外：排序箭头仍用裸 --primary（非正文，AA 门槛是 3:1）', () => {
    const lines = codeOf(read(STYL)).split('\n')
    const hits = lines
      .map((l, i) => ({ l, i }))
      .filter(x => /^\s+color var\(--primary\)$/.test(x.l))
    assert.equal(hits.length, 1, 'color var(--primary) 作正文色只允许留给排序箭头，实际 ' + hits.length + ' 处')
    let owner = ''
    for (let i = hits[0].i; i >= 0; i--) {
      if (/^\.\S/.test(lines[i])) { owner = lines[i]; break }
    }
    assert.equal(owner, '.db-col-sort-active')
  })
})
