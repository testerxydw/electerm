const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/components/database/db-highlight.jsx')

// highlightValue 是 .jsx（返回 JSX 片段），node 无法直接 require。
// 抽真实函数源码，用 React.createElement 桩在 vm 里跑——测的是发布实现。
// 背景见 doc/已完成/数据库功能设计归档-2026-10-21.md 同目录的值预览高亮修复：
// 表格单元格默认上限（4096/200）防正则拖慢整表；值预览 <pre> 单值专用查看区，
// 通过 opts 放宽上限（大 JSON 也要高亮）
const loadHighlightValue = () => {
  const src = fs.readFileSync(SRC, 'utf8')
  const m = src.match(/export function highlightValue \([\s\S]*?\n\}/)
  assert.ok(m, 'highlightValue definition not found in db-highlight.jsx')
  // 源码含 JSX，node 不能直接跑：把唯一的 <span> 块定向替换为 createElement 调用。
  // 替换失配（实现漂移）会让 '<' 留在源里 → vm 语法错误 → 本套件响亮失败（防漂移）
  let body = m[0].replace(/^export /, '')
  const jsx = body.match(/<span[\s\S]*?<\/span>/)
  assert.ok(jsx, 'span JSX block not found (implementation drifted?)')
  body = body.replace(
    jsx[0],
    "React.createElement('span', " +
    "{ key: h.start, className: 'db-kw', style: (themeConfig && themeConfig[h.color] ? { color: themeConfig[h.color] } : undefined) }, " +
    'text.slice(h.start, h.end))'
  )
  const sandbox = {
    // createElement 桩：够断言分段结构即可；模块级上限常量一并注入
    maxHighlightLength: 4096,
    maxHits: 200,
    React: {
      createElement: (type, props, ...children) => ({ type, props, children })
    }
  }
  vm.runInNewContext(body, sandbox)
  return sandbox.highlightValue
}

const IP_RE = /192[.]168[.]115[.][0-9]+/gi
const patterns = [{ re: IP_RE, color: 'red' }]
const countSpans = parts => Array.isArray(parts)
  ? parts.filter(p => p && p.type === 'span').length
  : 0

describe('highlightValue: long-text limits (real source)', () => {
  const highlightValue = loadHighlightValue()
  const theme = { red: '#ff0000' }
  // 超过默认上限 4096 的大文本（用户反馈的大 JSON 值场景）
  const bigText = 'x'.repeat(4000) + ' host=192.168.115.67 ' + 'y'.repeat(2000)

  test('default: text longer than 4096 is skipped (table cell performance)', () => {
    const out = highlightValue(bigText, patterns, theme)
    assert.equal(out, bigText, 'default must not highlight over-length text')
  })

  test('preview opts maxLength lift the limit (value pre use case)', () => {
    const out = highlightValue(bigText, patterns, theme, { maxLength: 100000, maxHits: 2000 })
    assert.ok(Array.isArray(out), 'long preview text must be highlighted')
    assert.equal(countSpans(out), 1)
  })

  test('preview opts maxHits caps the number of spans', () => {
    const text = Array.from({ length: 10 }, () => 'ip=192.168.115.67;').join('')
    const out = highlightValue(text, patterns, theme, { maxLength: 100000, maxHits: 3 })
    assert.equal(countSpans(out), 3)
  })

  test('no opts: short text keeps default behavior (highlighted)', () => {
    const out = highlightValue('ip=192.168.115.67', patterns, theme)
    assert.equal(countSpans(out), 1)
  })

  test('no patterns: text returned as-is even with opts', () => {
    const out = highlightValue('plain', [], theme, { maxLength: 100000, maxHits: 2000 })
    assert.equal(out, 'plain')
  })
})
