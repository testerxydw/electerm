/**
 * 统一错误弹窗（错误类专用，与功能性 Modal 完全分离）
 *
 * 架构原则：功能性弹窗走功能性 Modal（modal.jsx），错误类弹窗走本模块——不混用。
 * 本模块是错误类弹窗的唯一统一入口，恒带"一键复制 + 关闭"按钮，复制错误消息全文。
 * 复制/格式/文本提取全部收敛于此，各业务错误弹窗无需重复实现。
 *
 * 两种用法：
 *  1) showErrorModal(options) —— 命令式弹出（无需受控状态），返回 { destroy }。
 *  2) <ErrorModal open=... onCancel=...> —— 受控式（嵌入已有组件树）。
 *
 * options：
 *  - title  标题文案
 *  - error  错误对象/字符串（优先），否则 message / description / children 兜底
 *  - copyText 显式指定复制内容（默认=展示的文本）
 *  - width / onOk / onCancel / maskClosable / okText / cancelText
 */
import { CloseOutlined, CopyOutlined } from '@ant-design/icons'
import classnames from 'classnames'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { copy } from '../../common/clipboard'
import { getTextFromReactChildren } from '../../common/react-text'
import './error-modal.styl'

const e = window.translate

// 归一化错误文本：error 对象优先取其 message，其次是 message/description/children
function resolveErrorText (options) {
  const { error, message, description, children } = options
  if (error !== undefined && error !== null) {
    if (typeof error === 'string' || typeof error === 'number') {
      return String(error)
    }
    return error && error.message ? String(error.message) : String(error)
  }
  return message || description || children || ''
}

export default function ErrorModal (props) {
  const {
    open,
    title = e('error'),
    error,
    message,
    description,
    children,
    copyText,
    width = 480,
    maskClosable = true,
    onOk,
    okText = e('ok'),
    onCancel,
    className
  } = props

  if (!open) {
    return null
  }

  const text = resolveErrorText({ error, message, description, children })
  const copyTarget = copyText !== undefined && copyText !== null ? copyText : text
  const wrapCls = classnames('error-modal-wrap', className)

  return (
    <div className={wrapCls}>
      <div className='error-modal-mask' onClick={() => maskClosable && onCancel && onCancel()} />
      <div
        className='error-modal-box'
        style={{ width: typeof width === 'number' ? `${width}px` : width }}
      >
        <div className='error-modal-head'>
          <span className='error-modal-title'>{title}</span>
          <div className='error-modal-head-actions'>
            <button
              type='button'
              className='error-modal-copy'
              title={e('copyError')}
              onClick={() => copy(getTextFromReactChildren(copyTarget))}
            >
              <CopyOutlined />
            </button>
            <button
              type='button'
              className='error-modal-close'
              title={e('close')}
              onClick={() => onCancel && onCancel()}
            >
              <CloseOutlined />
            </button>
          </div>
        </div>
        <div className='error-modal-body'>
          <div className='error-modal-text'>{text}</div>
        </div>
        {(onOk || onCancel) && (
          <div className='error-modal-footer'>
            {onCancel && (
              <button type='button' className='error-modal-cancel' onClick={onCancel}>
                {e('cancel')}
              </button>
            )}
            {onOk && (
              <button type='button' className='error-modal-ok' onClick={onOk}>
                {okText}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 命令式：弹出错误弹窗，返回 { destroy }
export function showErrorModal (options) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const destroy = () => {
    if (root && container && container.parentNode) {
      root.unmount()
      document.body.removeChild(container)
    }
  }

  const {
    onOk,
    onCancel,
    ...rest
  } = options

  const handleOk = () => {
    if (onOk) {
      onOk()
    }
    destroy()
  }
  const handleCancel = () => {
    if (onCancel) {
      onCancel()
    }
    destroy()
  }

  root.render(
    <ErrorModal
      open
      {...rest}
      onOk={handleOk}
      onCancel={handleCancel}
    />
  )

  return { destroy }
}
