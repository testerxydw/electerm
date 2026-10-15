/**
 * 数据库统一值预览/编辑面板（mysql 单元格、redis 键值共用；其他数据库引擎可复用）
 *
 * 只读态：关键字高亮 + 格式化切换（嗅探 JSON/Python/XML/URL）+ 复制；
 * 编辑态（editable 时）：raw 文本编辑，保存交给引擎适配回调 onSave（mysql=UPDATE / redis=SET …）。
 * 格式化视图只读（编辑始终针对 raw 原文）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Button, Input } from 'antd'
import { CopyOutlined, CloseOutlined, SwapOutlined } from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { detectFormats, formatValue } from './db-value-format'
import { highlightValue } from './db-highlight'

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
    onClose
  } = props
  const [formatKey, setFormatKey] = useState('raw')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

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
  return (
    <div className='db-value-pane'>
      <div className='db-value-pane-head'>
        <span className='db-grid-title'>{title}</span>
        {
          meta
            ? <span className='db-grid-total'>{meta}</span>
            : null
        }
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
              className='db-value-pane-text'
              value={draft}
              onChange={ev => setDraft(ev.target.value)}
            />
            )
          : (
            <pre className='db-value-pre db-value-pane-pre'>
              {highlighted}
            </pre>
            )
      }
    </div>
  )
}
