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
import { formatValue } from './db-value-format'
import { highlightValue } from './db-highlight'
import { selectRenderers, isBinEnvelope, binPreviewBytes } from './value-renderers'

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

// 二进制信封按呈现器解码出预览文本（用于高亮 <pre>）。
// image/blob-info 由 UI 单独渲染，这里返回空串避免把 base64 当文本高亮。
function binPreviewText (value, key) {
  if (!isBinEnvelope(value)) {
    return String(value)
  }
  const env = value.__bin
  if (key === 'hex') {
    return binPreviewBytes(env).toString('hex')
  }
  if (key === 'base64' || key === 'raw') {
    return env.b64
  }
  return ''
}

// 从二进制前缀猜图片 mime（仅前几字节足够判定常见格式）
function guessImageMime (bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  return null
}

// 二进制 image 呈现器：信封内联 4KB 前缀够预览小图；判定为非图像则提示换 HEX/Base64
function renderBinaryImage (env) {
  const bytes = binPreviewBytes(env)
  const mime = guessImageMime(bytes)
  if (!mime) {
    return (
      <div className='db-value-pre db-value-pane-pre db-value-bin-note'>
        {e('dbBinNotImage')}
      </div>
    )
  }
  return (
    <div className='db-value-bin-image'>
      <img src={'data:' + mime + ';base64,' + env.b64} alt='binary' />
      <div className='db-value-bin-meta'>
        {e('dbBinSize')}: {env.size}{env.truncated ? ' (' + e('dbBinTruncated') + ')' : ''} · {mime}
      </div>
    </div>
  )
}

// 二进制 blob-info 呈现器：元数据卡 + 前若干字节 hex 预览
function renderBlobInfo (env) {
  const bytes = binPreviewBytes(env)
  const previewHex = bytes.subarray(0, 64).toString('hex')
  return (
    <div className='db-value-pre db-value-pane-pre db-value-bin-info'>
      <div><b>{e('dbBinEnvelope')}</b></div>
      <div>{e('dbBinSize')}: {env.size} bytes{env.truncated ? ' (' + e('dbBinTruncated') + ')' : ''}</div>
      <div>{e('dbBinPreview')} (hex): {previewHex}{bytes.length > 64 ? '…' : ''}</div>
      <div className='db-value-bin-note'>{e('dbBinReadonly')}</div>
    </div>
  )
}

export default function DbValuePane (props) {
  const {
    title,
    meta = '',
    value = '',
    column = {},
    patterns,
    themeConfig,
    editable = false,
    saving = false,
    maxLength = 100000,
    maxHits = 2000,
    onSave,
    onClose,
    extra,
    editDisabledTitle = ''
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

  const isEnv = isBinEnvelope(value)
  // F3 §9.2：用注册表统一选取可用呈现器（文本 / 二进制），默认项按注册表决定
  const selection = useMemo(() => selectRenderers(value, column), [value, column])
  const active = selection.renderers.find(r => r.key === formatKey) ||
    selection.renderers[0] || { key: 'raw', readonly: false, label: 'raw' }
  const activeKey = active.key
  const formatLabel = activeKey === 'raw' ? e('rawText') : activeKey
  // 二进制呈现器全部 readonly（写回会破坏数据）；截断的大字段也强制只读
  const truncatedEnv = isEnv && value.__bin && value.__bin.truncated === true
  const readOnlyRenderer = active.readonly === true || truncatedEnv
  const effectiveEditable = editable && !readOnlyRenderer

  // 二进制按呈现器解码预览文本；image/blob-info 单独渲染，这里给占位
  const shown = isEnv
    ? binPreviewText(value, activeKey)
    : (activeKey === 'raw' ? String(value) : formatValue(String(value), activeKey))
  const highlighted = useMemo(
    () => highlightValue(shown, patterns, themeConfig, { maxLength, maxHits }),
    [shown, patterns, themeConfig, maxLength, maxHits]
  )
  const dirty = editing && draft !== value
  const startEdit = () => {
    if (readOnlyRenderer) {
      return
    }
    setDraft(value)
    setEditing(true)
  }
  const toggleFormat = () => {
    const list = selection.renderers
    if (list.length < 2) {
      return
    }
    const idx = list.findIndex(r => r.key === activeKey)
    const next = list[(idx + 1) % list.length]
    setFormatKey(next.key)
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
        <Button
          size='small'
          icon={<CopyOutlined />}
          title={e('copy')}
          onClick={() => copy(isEnv ? value.__bin.b64 : value)}
        />
        {
          selection.renderers.length > 1
            ? (
              <Button size='small' disabled={editing} onClick={toggleFormat}>
                <SwapOutlined /> {formatLabel}
              </Button>
              )
            : null
        }
        {
          // 与右键菜单保持一致：edit 恒显示，不可编辑时置灰并提示原因
          // （mysql 无主键 / 只读实例 / 二进制只读），避免两个引擎菜单观感不一致
          (effectiveEditable || editing)
            ? editing
              ? (
                <>
                  <Button size='small' type='primary' disabled={!dirty || saving} onClick={save}>
                    {e('save')}
                  </Button>
                  <Button size='small' disabled={saving} onClick={() => setEditing(false)}>
                    {e('cancel')}
                  </Button>
                </>
                )
              : (
                <Button
                  size='small'
                  disabled={!effectiveEditable || saving}
                  title={effectiveEditable ? e('edit') : (readOnlyRenderer ? e('dbBinReadonly') : editDisabledTitle)}
                  onClick={startEdit}
                >
                  {e('edit')}
                </Button>
                )
            : null
        }
        {
          onClose
            ? <Button size='small' icon={<CloseOutlined />} title={e('close')} onClick={onClose} />
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
          : isEnv && activeKey === 'image'
            ? renderBinaryImage(value.__bin)
            : isEnv && activeKey === 'blob-info'
              ? renderBlobInfo(value.__bin)
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
                    {
                      // 恒显示，不可编辑置灰（与头部 edit 按钮一致）
                      key: 'edit',
                      label: (
                        <span title={effectiveEditable ? undefined : (readOnlyRenderer ? e('dbBinReadonly') : editDisabledTitle)}>{e('edit')}</span>
                      ),
                      disabled: !effectiveEditable
                    },
                    {
                      key: 'replace',
                      label: (
                        <span title={effectiveEditable ? undefined : (readOnlyRenderer ? e('dbBinReadonly') : editDisabledTitle)}>{e('replace')}</span>
                      ),
                      // 格式化视图不对应原文，替换无意义 → 置灰
                      disabled: !effectiveEditable || activeKey !== 'raw'
                    }
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
