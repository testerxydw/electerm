/**
 * 数据库统一值预览/编辑面板（mysql 单元格、redis 键值共用；其他数据库引擎可复用）
 *
 * 只读态：关键字高亮 + 格式化切换（嗅探 JSON/Python/XML/URL）+ 复制；
 * 预览内容可部分选中后右键：复制选中片段 / 编辑 / 替换（替换 = 进编辑态并预选该片段）；
 * 编辑态（editable 时）：raw 文本编辑，保存交给引擎适配回调 onSave（mysql=UPDATE / redis=SET …）。
 * 格式化视图只读（编辑始终针对 raw 原文，替换仅 raw 视图提供）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown, Input } from 'antd'
import { CopyOutlined, CloseOutlined, SwapOutlined } from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { detectFormats, formatValue } from './db-value-format'
import { highlightValue } from './db-highlight'

const e = window.translate

// 取当前 selection 在容器内的文本范围（高亮会产生多个 <span>，按 textNode 累加偏移）。
// 返回 { text, start, end }；无选中/选区不在容器内返回 null。
function getSelRangeIn (el) {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed || !el) {
    return null
  }
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
    return null
  }
  const offsetOf = (node, offset) => {
    let total = 0
    const walker = document.createTreeWalker(el, window.NodeFilter.SHOW_TEXT)
    let cur = walker.nextNode()
    while (cur) {
      if (cur === node) {
        return total + offset
      }
      total += cur.nodeValue.length
      cur = walker.nextNode()
    }
    return -1
  }
  const start = offsetOf(range.startContainer, range.startOffset)
  const end = offsetOf(range.endContainer, range.endOffset)
  if (start < 0 || end < 0) {
    return null
  }
  return {
    text: sel.toString(),
    start: Math.min(start, end),
    end: Math.max(start, end)
  }
}

export default function DbValuePane (props) {
  const {
    title,
    meta = '',
    value = '',
    patterns,
    themeConfig,
    editable = false,
    saving = false,
    maxLength = 100000,
    maxHits = 2000,
    onSave,
    onClose,
    extra
  } = props
  const [formatKey, setFormatKey] = useState('raw')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  // 预览区选中右键菜单：复制选中片段 / 编辑 / 替换
  const [menu, setMenu] = useState(null)
  // 替换动作：进编辑态后要把该范围预选到 textarea 上
  const [pendingRange, setPendingRange] = useState(null)
  const preRef = useRef(null)
  const textRef = useRef(null)

  // 值变化（换单元格/切键/保存后刷新）→ 退出编辑态、回落原文视图
  useEffect(() => {
    setEditing(false)
    setDraft(value)
    setFormatKey('raw')
  }, [value])

  const formats = useMemo(() => (value ? detectFormats(value) : []), [value])
  const activeFormat = formatKey !== 'raw' && formats.some(f => f.key === formatKey)
    ? formatKey
    : 'raw'
  const formatLabel = activeFormat === 'raw' ? 'raw' : activeFormat
  const shown = activeFormat === 'raw' ? value : formatValue(value, activeFormat)
  const highlighted = useMemo(
    () => highlightValue(shown, patterns, themeConfig, { maxLength, maxHits }),
    [shown, patterns, themeConfig, maxLength, maxHits]
  )
  const dirty = editing && draft !== value
  const startEdit = () => {
    setDraft(value)
    setEditing(true)
  }
  const toggleFormat = () => {
    setFormatKey(activeFormat === 'raw' ? (formats[0] ? formats[0].key : 'raw') : 'raw')
  }
  const save = () => {
    if (dirty && !saving && onSave) {
      onSave(draft)
    }
  }

  // 替换进入编辑态后，把选中范围预选到 textarea 上（直接输入即覆盖该片段）
  useEffect(() => {
    if (!editing || !pendingRange) {
      return
    }
    const ta = textRef.current && textRef.current.resizableTextArea
      ? textRef.current.resizableTextArea.textArea
      : textRef.current
    if (ta && ta.setSelectionRange) {
      ta.focus()
      ta.setSelectionRange(pendingRange[0], pendingRange[1])
    }
    setPendingRange(null)
  }, [editing, pendingRange])

  // 右键预览区：有选中才弹自定义菜单（无选中走系统默认菜单）
  const onPreContextMenu = ev => {
    const info = getSelRangeIn(preRef.current)
    if (!info) {
      return
    }
    ev.preventDefault()
    setMenu({ x: ev.clientX, y: ev.clientY, ...info })
  }

  const closeMenu = ev => {
    if (!ev.target.closest || !ev.target.closest('.ant-dropdown')) {
      setMenu(null)
    }
  }

  // 受控 Dropdown 点外面不会自动收起，这里补全局 mousedown 关闭
  useEffect(() => {
    if (!menu) {
      return undefined
    }
    document.addEventListener('mousedown', closeMenu, true)
    return () => document.removeEventListener('mousedown', closeMenu, true)
  }, [menu])

  const onMenuClick = ({ key, domEvent }) => {
    domEvent.preventDefault()
    domEvent.stopPropagation()
    const m = menu
    setMenu(null)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
    }
    if (!m) {
      return
    }
    if (key === 'copy') {
      copy(m.text)
    } else if (key === 'edit') {
      startEdit()
    } else if (key === 'replace') {
      startEdit()
      setPendingRange([m.start, m.end])
    }
  }

  return (
    <div className='db-value-pane'>
      <div className='db-value-pane-head'>
        <span className='db-grid-title'>{title}</span>
        {
          meta
            ? <span className='db-grid-total'>{meta}</span>
            : null
        }
        {extra}
        <Button size='small' icon={<CopyOutlined />} title='copy' onClick={() => copy(value)} />
        {
          formats.length
            ? (
              <Button size='small' disabled={editing} onClick={toggleFormat}>
                <SwapOutlined /> {formatLabel}
              </Button>
              )
            : null
        }
        {
          editable
            ? editing
              ? (
                <>
                  <Button size='small' type='primary' disabled={!dirty || saving} onClick={save}>
                    save
                  </Button>
                  <Button size='small' disabled={saving} onClick={() => setEditing(false)}>
                    cancel
                  </Button>
                </>
                )
              : (
                <Button size='small' disabled={saving} onClick={startEdit}>
                  edit
                </Button>
                )
            : null
        }
        {
          onClose
            ? <Button size='small' icon={<CloseOutlined />} title='close' onClick={onClose} />
            : null
        }
      </div>
      {
        editing
          ? (
            <Input.TextArea
              ref={textRef}
              className='db-value-pane-text'
              value={draft}
              onChange={ev => setDraft(ev.target.value)}
            />
            )
          : (
            <pre
              className='db-value-pre db-value-pane-pre'
              ref={preRef}
              onContextMenu={onPreContextMenu}
            >
              {highlighted}
            </pre>
            )
      }
      {
        menu
          ? (
            <div
              style={{
                position: 'fixed',
                left: menu.x,
                top: menu.y,
                zIndex: 9999
              }}
            >
              <Dropdown
                open
                placement='bottomLeft'
                menu={{
                  items: [
                    { key: 'copy', label: e('copy') },
                    ...(editable
                      ? [
                          { key: 'edit', label: e('edit') },
                          ...(activeFormat === 'raw'
                            ? [{ key: 'replace', label: e('replace') }]
                            : [])
                        ]
                      : [])
                  ],
                  onClick: onMenuClick
                }}
              >
                <span />
              </Dropdown>
            </div>
            )
          : null
      }
    </div>
  )
}
