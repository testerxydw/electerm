/**
 * E1 危险语句确认弹窗（设计：doc/设计-数据库阶段4-增量批次-2026-10-23.md §6.4）
 *
 * 为什么用受控 Modal 而不是 Modal.confirm：
 * - production 连接要在弹窗里带一个"输入库名"的受控输入框，并且"仍要执行"按钮的
 *   可用状态跟着输入值变；Modal.confirm 只能塞静态内容，拿不到表单状态；
 * - 语句折叠列表本身也是弹窗内的局部状态。
 *
 * 组件只管展示与收集意图（确认/取消/是否静音），判定与放行全部由调用方
 * （db-session.jsx 的 gate）决定 —— 这样弹窗可以在别处复用。
 */

import { useEffect, useState } from 'react'
import { Modal, Button, Input, Checkbox } from 'antd'
import { DownOutlined, UpOutlined } from '@ant-design/icons'

const e = window.translate

// 等级 → 词条 key（颜色/样式由 CSS 类负责，见 db-session.styl）
const LEVEL_LABEL_KEY = {
  read: 'dbRiskRead',
  transaction: 'dbRiskTransaction',
  write: 'dbRiskWrite',
  ddl: 'dbRiskDdl',
  dangerous: 'dbRiskDangerous',
  unknown: 'dbRiskUnknown'
}

/**
 * 库名校验。
 * 为什么 trim 后忽略大小写：目的是防手滑（随手敲回车），不是安全校验。
 * 同一份书签在不同平台上对大小写的敏感度不同（MySQL 库名在 Windows/macOS 不敏感、
 * Linux 敏感；PG 未加引号的标识符一律折叠小写），严格区分大小写只会造成
 * "明明输对了却不让过"，进而训练用户盲点确认。
 * @param {string} input 用户输入
 * @param {string} expected 期望库名
 * @returns {boolean}
 */
function nameMatches (input, expected) {
  const a = String(input || '').trim().toLowerCase()
  const b = String(expected || '').trim().toLowerCase()
  return b !== '' && a === b
}

/**
 * 一条语句是否需要折叠开关（多行或过长才有意义）。
 * @param {string} text 语句文本
 * @returns {boolean}
 */
function needToggle (text) {
  const s = String(text || '')
  return s.includes('\n') || s.length > 120
}

export default function DbDangerConfirm (props) {
  const {
    open = false,
    level = 'unknown',
    production = false,
    statements = [],
    reasons = [],
    dbName = '',
    requireDbName = false,
    allowMute = false,
    onCancel = () => {},
    onConfirm = () => {}
  } = props
  const [expanded, setExpanded] = useState({})
  const [nameInput, setNameInput] = useState('')
  const [mute, setMute] = useState(false)

  // 每次（重新）打开都重置输入与展开态：上一次残留的库名会让"仍要执行"直接可点，
  // 库名校验就废了
  useEffect(() => {
    if (open) {
      setNameInput('')
      setMute(false)
      setExpanded({})
    }
  }, [open, level, statements.length])

  const expected = String(dbName || '').trim()
  // 连接没有默认库时无法要求"输入库名"（会是空字符串），此时退化为普通确认
  const needName = requireDbName === true && expected !== ''
  const nameOk = !needName || nameMatches(nameInput, expected)
  const danger = level === 'dangerous'
  const labelOf = lv => e(LEVEL_LABEL_KEY[lv] || 'dbRiskUnknown')

  const toggle = idx => {
    setExpanded(prev => ({ ...prev, [idx]: prev[idx] !== true }))
  }

  const submit = () => {
    if (!nameOk) {
      return
    }
    onConfirm({ mute: mute === true })
  }

  const header = (
    <div className='db-risk-title'>
      <span className={'db-risk-badge db-risk-badge-' + level}>
        {labelOf(level)}
      </span>
      {
        production
          ? <span className='db-risk-env'>{e('dbRiskProduction')}</span>
          : null
      }
      <span className='db-risk-count'>
        {e('dbRiskStatements').replace('{n}', String(statements.length))}
      </span>
    </div>
  )

  const footer = [
    <Button key='cancel' onClick={onCancel}>
      {e('cancel')}
    </Button>,
    <Button
      key='ok'
      type='primary'
      danger={danger}
      disabled={!nameOk}
      onClick={submit}
    >
      {e('dbRiskRunAnyway')}
    </Button>
  ]

  return (
    <Modal
      open={open}
      className='db-risk-modal'
      width={620}
      title={header}
      footer={footer}
      maskClosable={false}
      onCancel={onCancel}
    >
      <div className='db-risk-body'>
        {
          // 判定理由是弹窗的核心：只给"确定/取消"等于让人闭眼点确认
          reasons.length
            ? (
              <div className='db-risk-sec'>
                <div className='db-risk-sec-title'>{e('dbRiskReasons')}</div>
                <ul className='db-risk-reason-list'>
                  {
                    reasons.map((r, i) => (
                      <li key={i} className='db-risk-reason'>{r}</li>
                    ))
                  }
                </ul>
              </div>
              )
            : null
        }
        {
          statements.length
            ? (
              <div className='db-risk-sec'>
                <div className='db-risk-sec-title'>{e('dbRiskStmtList')}</div>
                <div className='db-risk-stmts'>
                  {
                    statements.map((st, i) => {
                      const text = String((st && st.text) || '')
                      const isOpen = expanded[i] === true
                      return (
                        <div className='db-risk-stmt' key={i}>
                          <div className='db-risk-stmt-head'>
                            <span className='db-risk-stmt-no'>{i + 1}</span>
                            <span className={'db-risk-stmt-lv db-risk-lv-' + ((st && st.level) || 'unknown')}>
                              {labelOf(st && st.level)}
                            </span>
                            {
                              needToggle(text)
                                ? (
                                  <Button
                                    className='db-risk-stmt-toggle'
                                    type='text'
                                    size='small'
                                    icon={isOpen ? <UpOutlined /> : <DownOutlined />}
                                    onClick={() => toggle(i)}
                                  />
                                  )
                                : null
                            }
                          </div>
                          <pre className={'db-risk-stmt-text' + (isOpen ? ' is-open' : '')}>
                            {text}
                          </pre>
                        </div>
                      )
                    })
                  }
                </div>
              </div>
              )
            : null
        }
        {
          allowMute
            ? (
              <Checkbox
                className='db-risk-mute'
                checked={mute}
                onChange={ev => setMute(ev.target.checked === true)}
              >
                {e('dbRiskMuteLowWrite')}
              </Checkbox>
              )
            : null
        }
        {
          needName
            ? (
              <div className='db-risk-dbname'>
                <div className='db-risk-dbname-label'>
                  {e('dbRiskDbNamePrompt').replace('{db}', expected)}
                </div>
                <Input
                  className='db-risk-dbname-input'
                  value={nameInput}
                  // 占位符不能填期望库名：那等于把答案写在输入框里
                  placeholder={e('dbName')}
                  status={nameInput && !nameOk ? 'error' : undefined}
                  onChange={ev => setNameInput(ev.target.value)}
                  onPressEnter={submit}
                />
              </div>
              )
            : null
        }
      </div>
    </Modal>
  )
}
