/**
 * React children → 纯文本（全局复用）
 *
 * 错误弹窗/通知的"一键复制"需要把可能是 React 节点（<div>、<code>、数组…）的
 * message/description 还原成可复制的纯文本。本函数递归提取叶子文本，数组按行拼接。
 * 供 notification.jsx 与 modal.jsx 等所有弹窗共用，避免各弹窗各写一份。
 */
import React from 'react'

export function getTextFromReactChildren (children) {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  if (React.isValidElement(children)) {
    return getTextFromReactChildren(children.props.children)
  }
  if (Array.isArray(children)) {
    return children.map(getTextFromReactChildren).join('\n')
  }
  return ''
}
