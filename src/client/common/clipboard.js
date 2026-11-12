/**
 * clipboard related
 */

import message from '../components/common/message'
import { getTextFromReactChildren } from './react-text'

const fileRegWin = /^(remote:)?\w:\\.+/
const fileReg = /^(remote:)?\/.+/

export const readClipboard = () => {
  return window.pre.readClipboard()
}

export const readClipboardAsync = () => {
  const {
    readClipboardSync,
    readClipboard
  } = window.pre
  return readClipboardSync ? readClipboardSync() : Promise.resolve(readClipboard())
}

// 全部复制入口的共用漏斗：调用方手里拿到的可能是 React 节点
// （错误弹窗的 message/description 常是 <div> 包着堆栈），直接写剪贴板
// 会变成 "[object Object]" —— 在这里统一还原成纯文本
const toClipboardText = (str) => {
  if (typeof str === 'string' || typeof str === 'number') {
    return String(str)
  }
  return getTextFromReactChildren(str)
}

export const copy = (str) => {
  message.success({
    content: window.translate('copied'),
    duation: 2,
    key: 'copy-message'
  })
  window.pre.writeClipboard(toClipboardText(str))
}

export const cut = (str, itemTitle = '') => {
  message.success('Cutted ' + itemTitle, 2)
  window.pre.writeClipboard(toClipboardText(str))
}

export const hasFileInClipboardText = (
  text = readClipboard()
) => {
  const arr = text.split('\n')
  return arr.reduce((prev, t) => {
    return prev &&
      (fileReg.test(t) || fileRegWin.test(t))
  }, true)
}
