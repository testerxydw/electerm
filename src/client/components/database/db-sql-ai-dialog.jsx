/**
 * SQL × AI 生成弹层（第一批：AI 产出只填编辑器，不执行）
 *
 * 为什么单独做弹层，而不是复用右侧 AI 对话面板：
 * - 对话面板的请求链路没有"返回通道"。一次提交只产出一条历史记录，要把回答送回
 *   编辑器就得给每条 turn 挂"目标 tab + 插入策略"，再处理"目标 tab 已关闭""期间
 *   又发了新消息"，复杂度全落在共享的对话链路上；
 * - 面板现在靠 setPrompt + 500/1200ms 两个魔法延时提交，时序本身就脆。
 * 项目里已有两条同类做法（快捷命令 AI 生成器、书签 AI 生成器）：描述 → 非流式请求
 * → 解析 → **预览 + 确认** → 落到目标对象。这个模式天然满足"人先看再落"，也不动对话链路。
 *
 * 本组件不碰编辑器也不碰执行：它只发请求、展示产出、把"插入策略"交回给会话页。
 * 风险分级只做**提示**（插入前就让人知道这段是写操作），拦截仍由执行时的
 * confirmSqlRisk 承担——这里没有任何绕过路径。
 */

import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Input, Alert, Tag, Segmented, Spin, message } from 'antd'
import { RobotOutlined, LoadingOutlined, CopyOutlined } from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { appendMandatoryGuardrails } from '../ai/ai-guardrails'
import { buildSqlAiPrompt, parseSqlFromAiResponse } from '../../common/db-sql-ai'
import { classifySql } from '../../common/db-sql-risk'
// 风险等级词条映射只此一份（危险确认弹窗在用），这里复用而不是抄一遍
import { LEVEL_LABEL_KEY } from './db-danger-confirm'

const e = window.translate
const { TextArea } = Input

const MODE_TITLE_KEY = {
  generate: 'dbAiGenTitle',
  fix: 'dbAiFixTitle',
  optimize: 'dbAiOptTitle'
}

// 主按钮文案：三种动作说人话，不要都写成"提交"
const MODE_ACTION_KEY = {
  generate: 'dbAiActionGenerate',
  fix: 'dbAiActionFix',
  optimize: 'dbAiActionOptimize'
}

export default function DbSqlAiDialog (props) {
  const {
    open = false,
    mode = 'generate',
    context = null,
    sql = '',
    selection = '',
    error = '',
    onClose,
    onInsert
  } = props

  const [instruction, setInstruction] = useState('')
  const [loading, setLoading] = useState(false)
  const [raw, setRaw] = useState('')
  const [failed, setFailed] = useState('')
  const [strategy, setStrategy] = useState('auto')

  // 每次打开（或换模式）都重置：留着上一次的回复，会让人误以为它是这次的结果
  useEffect(() => {
    if (!open) {
      return
    }
    setInstruction('')
    setRaw('')
    setFailed('')
    setLoading(false)
    setStrategy('auto')
  }, [open, mode])

  const parsed = useMemo(() => parseSqlFromAiResponse(raw), [raw])

  // 插入前就把风险分级显示出来：让人在"这段是要落库的写操作"上看一眼，
  // 而不是插完按下执行才被弹窗打断
  const risk = useMemo(() => {
    if (!parsed) {
      return null
    }
    return classifySql(parsed, (context && context.dbType) || 'mysql')
  }, [parsed, context])

  const ctxChips = useMemo(() => {
    const c = context || {}
    const chips = []
    if (c.dbType) {
      chips.push(c.dbType)
    }
    const where = [c.database, c.schema, c.table].filter(Boolean).join('.')
    if (where) {
      chips.push(where)
    }
    const cols = Array.isArray(c.columns) ? c.columns.length : 0
    if (cols) {
      chips.push(cols + ' cols')
    }
    return chips
  }, [context])

  async function run () {
    if (window.store.aiConfigMissing()) {
      window.store.toggleAIConfig()
      return
    }
    if (mode === 'generate' && !instruction.trim()) {
      message.warning(e('dbAiNeedInstruction'))
      return
    }
    const config = window.store.config || {}
    const built = buildSqlAiPrompt({
      mode,
      instruction,
      sql,
      selection,
      error,
      dbType: (context && context.dbType) || 'mysql',
      database: (context && context.database) || '',
      schema: (context && context.schema) || '',
      table: (context && context.table) || '',
      columns: (context && context.columns) || [],
      readOnly: !!(context && context.readOnly),
      language: config.languageAI
    })
    setLoading(true)
    setFailed('')
    try {
      // 非流式：要的是"一整段能预览的 SQL"，边流边刷反而看不出什么时候算完
      const res = await window.pre.runGlobalAsync(
        'AIchat',
        built.prompt,
        config.modelAI,
        appendMandatoryGuardrails(built.role),
        config.baseURLAI,
        config.apiPathAI,
        config.apiKeyAI,
        config.proxyAI,
        false,
        config.authHeaderNameAI
      )
      if (res && res.error) {
        throw new Error(res.error)
      }
      setRaw((res && res.response) || '')
    } catch (err) {
      setFailed((err && err.message) || e('dbAiRequestFailed'))
      setRaw('')
    } finally {
      setLoading(false)
    }
  }

  function doInsert () {
    if (!parsed) {
      return
    }
    // 会话页负责真正的落编辑器：它才有编辑器句柄与当前选区
    if (typeof onInsert === 'function') {
      onInsert(parsed, strategy)
    }
  }

  const strategyOptions = [
    { label: e('dbAiStrategyAuto'), value: 'auto' },
    { label: e('dbAiStrategyCursor'), value: 'cursor' },
    { label: e('dbAiStrategyReplace'), value: 'replace' }
  ]

  const footer = (
    <div className='db-sql-ai-footer'>
      <Button
        size='small'
        icon={loading ? <LoadingOutlined /> : <RobotOutlined />}
        loading={loading}
        onClick={run}
      >
        {raw ? e('dbAiActionAgain') : e(MODE_ACTION_KEY[mode] || 'dbAiActionGenerate')}
      </Button>
      <span className='db-sql-ai-spacer' />
      <Button
        size='small'
        icon={<CopyOutlined />}
        disabled={!parsed}
        onClick={() => copy(parsed)}
      >
        {e('copy')}
      </Button>
      <Button
        size='small'
        type='primary'
        disabled={!parsed || loading}
        onClick={doInsert}
      >
        {e('dbAiInsert')}
      </Button>
      <Button size='small' onClick={onClose}>
        {e('cancel')}
      </Button>
    </div>
  )

  return (
    <Modal
      open={open}
      title={e(MODE_TITLE_KEY[mode] || 'dbAiGenTitle')}
      onCancel={onClose}
      footer={footer}
      width={720}
      destroyOnHidden
    >
      <div className='db-sql-ai'>
        {
          // 上下文芯片：一眼看清这次带上了什么（方言/库表/列数/只读）
          ctxChips.length || (context && context.readOnly)
            ? (
              <div className='db-sql-ai-chips'>
                {ctxChips.map(c => <Tag key={c}>{c}</Tag>)}
                {
                  context && context.readOnly
                    ? <Tag color='orange'>{e('dbReadOnly')}</Tag>
                    : null
                }
              </div>
              )
            : null
        }
        {
          mode === 'generate'
            ? (
              <TextArea
                autoSize={{ minRows: 3, maxRows: 8 }}
                placeholder={e('dbAiInstructionPh')}
                value={instruction}
                onChange={ev => setInstruction(ev.target.value)}
                disabled={loading}
              />
              )
            : (
              <pre className='db-sql-ai-source'>
                {(selection || sql || '').trim()}
              </pre>
              )
        }
        {
          mode === 'fix' && error
            ? (
              <Alert
                className='pd1t'
                type='error'
                showIcon
                message={error}
              />
              )
            : null
        }
        {
          // 生成/修复/优化的补充要求：三种模式都能补一句话
          mode !== 'generate'
            ? (
              <TextArea
                className='pd1t'
                autoSize={{ minRows: 2, maxRows: 4 }}
                placeholder={e('dbAiExtraPh')}
                value={instruction}
                onChange={ev => setInstruction(ev.target.value)}
                disabled={loading}
              />
              )
            : null
        }
        {
          failed
            ? (
              <Alert
                className='pd1t'
                type='error'
                showIcon
                message={failed}
              />
              )
            : null
        }
        {
          loading
            ? (
              <div className='db-sql-ai-loading'>
                <Spin size='small' /> {e('dbAiWaiting')}
              </div>
              )
            : null
        }
        {
          !loading && raw
            ? (
              <div className='pd1t'>
                <div className='db-sql-ai-head'>
                  <span>{e('dbAiPreview')}</span>
                  {
                    risk
                      ? (
                        <Tag color={risk.level === 'read' ? 'green' : 'red'}>
                          {e('dbAiRiskPrefix')}: {e(LEVEL_LABEL_KEY[risk.level] || 'dbRiskUnknown')}
                        </Tag>
                        )
                      : null
                  }
                </div>
                {
                  parsed
                    ? <pre className='db-sql-ai-pre'>{parsed}</pre>
                    : (
                      <Alert
                        type='warning'
                        showIcon
                        message={e('dbAiNoSqlInReply')}
                        description={<pre className='db-sql-ai-raw'>{raw}</pre>}
                      />
                      )
                }
                <div className='db-sql-ai-strategy'>
                  <Segmented
                    size='small'
                    value={strategy}
                    onChange={setStrategy}
                    options={strategyOptions}
                  />
                  <span className='db-sql-ai-hint'>{e('dbAiInsertHint')}</span>
                </div>
              </div>
              )
            : null
        }
      </div>
    </Modal>
  )
}
