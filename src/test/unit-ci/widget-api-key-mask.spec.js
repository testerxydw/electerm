/**
 * P0-3：实例详情里的 API key 必须「看得见、认得清、但抄不走」。
 *
 * URL 不再携带 key 之后，面板是用户唯一的取 key 入口（复制按钮），所以 key
 * 必须真的显示出来；但可见文本和悬挂提示（title）都只能是掩码 —— 截图、
 * 投屏、共享窗口时，完整 key 出现在 title 里和出现在正文里一样危险。
 *
 * 直接跑真函数（从 JSX 源码里取出 maskApiKey 执行），而不是匹配源码文本：
 * 源码正则挡不住「title 换成未掩码的 instance.serverInfo.apiKey」这种泄漏，
 * 已用变异验证过（改完 title 泄漏完整 key，原断言仍 3/3 通过）。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const REPO = path.resolve(__dirname, '../../..')
const SRC_PATH = path.join(REPO, 'src/client/components/widgets/widget-instance-detail.jsx')
const src = fs.readFileSync(SRC_PATH, 'utf8')

/**
 * 从源码里抠出具名函数并执行，返回该函数本身。
 * @param {string} source
 * @param {string} name
 * @returns {Function}
 */
function extractFunction (source, name) {
  const start = source.indexOf(`function ${name} (`)
  assert.ok(start !== -1, `源码里找不到 function ${name}`)
  const braceStart = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') {
      depth++
    } else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.ok(end > braceStart, `${name} 的花括号没闭合`)
  const sandbox = { module: { exports: {} }, exports: {} }
  vm.runInNewContext(source.slice(start, end + 1) + `\nmodule.exports = ${name}`, sandbox)
  return sandbox.module.exports
}

const maskApiKey = extractFunction(src, 'maskApiKey')

describe('maskApiKey：前 4 + **** + 后 4', () => {
  it('长 key 只露首尾各 4 位，中间一律吃掉', () => {
    const key = 'sk-QA-MASK-PROBE-0123456789'
    const masked = maskApiKey(key)
    assert.equal(masked, 'sk-Q****6789')
    assert.ok(masked.length < key.length, '掩码必须比原文短')
    assert.ok(!masked.includes('MASK'), '中间段不得出现')
  })

  it('8 位及以下整串隐藏（首尾会重叠，露 4+4 等于全露）', () => {
    for (const key of ['a'.repeat(8), 'sk-1234', 'x']) {
      assert.equal(maskApiKey(key), '****', `key=${key}`)
    }
  })

  it('9 位起才露首尾', () => {
    assert.equal(maskApiKey('abcdefghi'), 'abcd****fghi')
  })

  it('空 / null / undefined 都返回空串，不出现 undefined 字样', () => {
    for (const v of ['', null, undefined, 0]) {
      assert.equal(maskApiKey(v), '', `v=${JSON.stringify(v)}`)
    }
  })
})

describe('实例详情：可见文本与 title 都是掩码，只有复制按钮拿全量', () => {
  it('可见文本和 title 都过 maskApiKey', () => {
    assert.match(
      src,
      /<span className='wil-mono' title=\{maskApiKey\(instance\.serverInfo\.apiKey\)\}>\s*\{maskApiKey\(instance\.serverInfo\.apiKey\)\}/,
      'title 与正文都必须用 maskApiKey 包裹'
    )
  })

  it('不得有任何一处把完整 key 塞进 title / 正文', () => {
    // 变异靶子：title={instance.serverInfo.apiKey} 肉眼几乎看不出，必须由断言挡住
    assert.doesNotMatch(src, /title=\{instance\.serverInfo\.apiKey\}/)
    assert.doesNotMatch(src, /title=\{instance\.serverInfo\?\.apiKey\}/)
    assert.doesNotMatch(src, />\s*\{instance\.serverInfo\.apiKey\}\s*</)
  })

  it('复制按钮拿的是全量 key（用户唯一能取回 key 的出口）', () => {
    assert.match(src, /onClick=\{\(\) => copy\(instance\.serverInfo\.apiKey\)\}/)
    assert.match(src, /title='Copy API key'/)
  })

  it('serverInfo.apiKey 为空时不渲染信息项与按钮', () => {
    const occurrences = src.match(/instance\.serverInfo && instance\.serverInfo\.apiKey/g) || []
    assert.ok(occurrences.length >= 2, `信息项与按钮各需一次存在性判断，实际 ${occurrences.length} 处`)
  })
})
