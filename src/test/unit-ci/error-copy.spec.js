/**
 * 错误展示/复制链契约 —— "[object Object]" 复制丢堆栈问题的三道锁
 *
 * 背景（N7 实机反馈）：渲染异常经 error-handler → notification 展示时
 * description 是 React 元素（内含 stack），notification 的复制按钮只对
 * message 做了文本还原，descriptions 直接 join —— 剪贴板只剩
 * "消息\n[object Object]"，堆栈全丢，报障等于没报。
 *
 * 三道锁：
 * 1. notification 复制：descriptions 逐条 getTextFromReactChildren（根修）
 * 2. clipboard.copy 共用漏斗：非字符串输入统一文本化（兜底，所有 copy() 调用点受益）
 * 3. error-modal resolveErrorText：Error 对象带 stack 时保留堆栈（展示与复制同口径）
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(p, 'utf8')

const NOTIF = path.join(ROOT, 'src/client/components/common/notification.jsx')
const CLIP = path.join(ROOT, 'src/client/common/clipboard.js')
const EMODAL = path.join(ROOT, 'src/client/components/common/error-modal.jsx')
const EHANDLER = path.join(ROOT, 'src/client/common/error-handler.jsx')

describe('错误复制链：堆栈不许在复制时丢成 [object Object]', () => {
  test('notification 复制：descriptions 逐条还原文本', () => {
    const s = read(NOTIF)
    assert.match(s,
      /validDescriptions\.map\(d => getTextFromReactChildren\(d\)\)/,
      'handleCopy 必须对每条 description 做文本还原')
    assert.equal(
      /\.\.\.validDescriptions\]/.test(s),
      false,
      '不得残留"React 元素直接 join"的旧写法')
  })

  test('clipboard.copy 共用漏斗：非字符串输入统一文本化', () => {
    const s = read(CLIP)
    assert.match(s, /import \{ getTextFromReactChildren \} from '\.\/react-text'/)
    assert.match(s, /const toClipboardText = \(str\) => \{/)
    assert.match(s, /writeClipboard\(toClipboardText\(str\)\)/,
      'copy() 是全部复制入口的漏斗，必须先归一化再写剪贴板')
    assert.equal(/writeClipboard\(str\)/.test(s), false, '不得残留直写')
  })

  test('error-modal：Error 对象带 stack 时展示与复制都保留堆栈', () => {
    const s = read(EMODAL)
    assert.match(s, /error\.stack \? msg \+ '\\n' \+ String\(error\.stack\) : msg/,
      'resolveErrorText 必须保留堆栈（与 error-handler/notification 同口径）')
  })

  test('error-handler：description 仍是带 stack 的 React 元素（展示侧不变）', () => {
    const s = read(EHANDLER)
    assert.match(s, /const description = \(/, '展示侧保持 React 元素（渲染出堆栈）')
    assert.match(s, /\{stack\}/)
  })
})
