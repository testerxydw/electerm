/**
 * 行详情（H1 / H2 共用渲染体）
 *
 * SQL 结果用 Modal 承载（本文件 DbRowDetailModal）；数据网格的底部"行"页签
 * 复用 DbRowDetail 本体，两边不各写一份字段列表。只读 —— 改值仍走单元格编辑。
 * 长文本/JSON 默认折叠到 500 字符，逐字段可展开、可复制。
 */
import React, { useEffect, useState } from 'react'
import { Button, Modal } from 'antd'
import { CopyOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import {
  ROW_DETAIL_INLINE_MAX,
  isLongRowValue,
  rowDetailCopyText,
  rowDetailObject,
  rowDetailText
} from './db-row-detail-utils'

const e = window.translate

function RowDetailField (props) {
  const { name, type, value } = props
  const text = rowDetailText(value)
  const long = isLongRowValue(text)
  const [expanded, setExpanded] = useState(false)
  // 同名字段换了值（收起→重开 Modal 看另一行）要收回折叠态，
  // 否则上一行的展开状态会带过来，新值一进来就直接铺满
  useEffect(() => {
    setExpanded(false)
  }, [text])
  const shown = long && !expanded
    ? text.slice(0, ROW_DETAIL_INLINE_MAX) + '…'
    : text
  return (
    <div className='db-row-detail-item'>
      <div className='db-row-detail-name'>
        <span className='db-row-detail-field' title={name}>{name}</span>
        {
          type
            ? <span className='db-row-detail-type'>{type}</span>
            : null
        }
      </div>
      <pre className={'db-row-detail-value' + (value === null ? ' is-null' : '')}>{shown}</pre>
      {
        long
          ? (
            <Button
              size='small'
              type='link'
              icon={expanded ? <UpOutlined /> : <DownOutlined />}
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? e('dbRowDetailCollapse') : e('dbRowDetailExpand')}
            </Button>
            )
          : null
      }
      <Button
        size='small'
        type='text'
        icon={<CopyOutlined />}
        title={e('copy')}
        onClick={() => copy(rowDetailCopyText(value))}
      />
    </div>
  )
}

export function DbRowDetail (props) {
  const { columns = [], row = {}, types = {} } = props
  return (
    <div className='db-row-detail'>
      {
        columns.map(k => (
          <RowDetailField
            key={k}
            name={k}
            type={types[String(k).toLowerCase()] || ''}
            value={row[k]}
          />
        ))
      }
    </div>
  )
}

export function DbRowDetailModal (props) {
  const { open, columns = [], row = {}, types = {}, onClose } = props
  return (
    <Modal
      open={open}
      title={e('dbRowDetailTitle')}
      width={720}
      onCancel={onClose}
      footer={[
        <Button
          key='copy'
          icon={<CopyOutlined />}
          onClick={() => copy(JSON.stringify(rowDetailObject(columns, row), null, 2))}
        >
          {e('dbRowDetailCopyRow')}
        </Button>,
        <Button key='close' type='primary' onClick={onClose}>
          {e('close')}
        </Button>
      ]}
    >
      <div className='db-row-detail-scroll'>
        <DbRowDetail columns={columns} row={row} types={types} />
      </div>
    </Modal>
  )
}
