/**
 * H6a：命名参数填写面板
 *
 * 只负责"把每个 :name 的值收上来"，执行是父组件的事：
 * 值以参数绑定发送（mysql2 `?` / pg `$n`），这里不拼 SQL，也不做转义。
 * 值只活在当前 tab 的内存里（父组件的 memo），关掉应用就没了。
 */

import { useEffect, useState } from 'react'
import { Modal, Button, Input, Checkbox } from 'antd'

const e = window.translate

export default function DbSqlParamsModal (props) {
  const { open, names, initial, onSubmit, onCancel } = props
  const [rows, setRows] = useState({})

  // 只在"打开"这一下灌初值：打开期间再渲染不该把用户敲了一半的值冲掉
  useEffect(() => {
    if (!open) {
      return
    }
    const next = {}
    ;(names || []).forEach(n => {
      const seed = (initial || {})[n]
      next[n] = {
        value: seed && typeof seed.value === 'string' ? seed.value : '',
        isNull: !!(seed && seed.isNull)
      }
    })
    setRows(next)
  }, [open])

  const patch = (name, part) => {
    setRows(r => ({ ...r, [name]: { ...(r[name] || { value: '', isNull: false }), ...part } }))
  }

  const submit = () => {
    const out = {}
    ;(names || []).forEach(n => {
      const r = rows[n] || { value: '', isNull: false }
      out[n] = r.isNull ? null : r.value
    })
    onSubmit(out)
  }

  return (
    <Modal
      className='db-params-modal'
      open={open}
      width={520}
      title={e('dbSqlParamsTitle')}
      onCancel={onCancel}
      footer={[
        <Button key='cancel' size='small' onClick={onCancel}>
          {e('cancel')}
        </Button>,
        <Button key='run' size='small' type='primary' onClick={submit}>
          {e('dbRun')}
        </Button>
      ]}
    >
      <div className='db-params'>
        <div className='db-params-hint'>{e('dbSqlParamsHint')}</div>
        {
          (names || []).map(n => (
            <div key={n} className='db-params-row'>
              <span className='db-params-name' title={':' + n}>{':' + n}</span>
              <Input
                size='small'
                className='db-params-input'
                value={(rows[n] && rows[n].value) || ''}
                disabled={!!(rows[n] && rows[n].isNull)}
                placeholder={e('dbSqlParamsValue')}
                onChange={ev => patch(n, { value: ev.target.value })}
                onPressEnter={submit}
              />
              <Checkbox
                className='db-params-null'
                checked={!!(rows[n] && rows[n].isNull)}
                onChange={ev => patch(n, { isNull: ev.target.checked })}
              >
                NULL
              </Checkbox>
            </div>
          ))
        }
      </div>
    </Modal>
  )
}
