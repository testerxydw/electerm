// 统一"一键复制"公共文本提取函数回归：
// notification（右下角通知）与 error-modal（错误类弹窗）共用同一实现，
// 这里钉住各形态输入 → 纯文本的转换契约
// 注意：node --test 直跑不支持 JSX，React 节点用 createElement 构造
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')

const h = React.createElement

// react-text 是 ESM（client 侧约定），node --test 下用动态 import 加载
let getTextFromReactChildren

describe('common/react-text getTextFromReactChildren', () => {
  test('加载模块', async () => {
    const m = await import('../../../src/client/common/react-text.js')
    getTextFromReactChildren = m.getTextFromReactChildren
    assert.equal(typeof getTextFromReactChildren, 'function')
  })
  test('字符串与数字原样返回', () => {
    assert.equal(getTextFromReactChildren('Request failed with status code 401'), 'Request failed with status code 401')
    assert.equal(getTextFromReactChildren(42), '42')
  })

  test('React 元素递归提取文本', () => {
    assert.equal(
      getTextFromReactChildren(h('div', null, 'connect ECONNREFUSED 127.0.0.1:3306')),
      'connect ECONNREFUSED 127.0.0.1:3306'
    )
    assert.equal(
      getTextFromReactChildren(h('div', null, 'a', h('b', null, 'b'), 'c')),
      'a\nb\nc'
    )
  })

  test('数组按行拼接（多行错误描述）', () => {
    assert.equal(
      getTextFromReactChildren(['line1', 'line2', 'line3']),
      'line1\nline2\nline3'
    )
  })

  test('null/undefined/对象等空值返回空串（不抛错）', () => {
    assert.equal(getTextFromReactChildren(null), '')
    assert.equal(getTextFromReactChildren(undefined), '')
    assert.equal(getTextFromReactChildren({ nested: true }), '')
    assert.equal(getTextFromReactChildren(false), '')
  })

  test('混合形态：错误弹窗 message + 数组 description 的真实场景', () => {
    const desc = [
      h('div', null, 'Error: Request failed with status code 401'),
      'at http://127.0.0.1:30975/js/electerm-5.7.15.js:2:118228'
    ]
    const out = getTextFromReactChildren(desc)
    assert.ok(out.includes('status code 401'))
    assert.ok(out.includes('electerm-5.7.15.js'))
    assert.equal(out.split('\n').length, 2)
  })
})
