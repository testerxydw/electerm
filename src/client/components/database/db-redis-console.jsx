/**
 * N5a · Redis 命令控制台（弹层）
 *
 * 职责：把一行命令递给主进程，把回来说清楚。**不含任何安全判定** ——
 * 分词、黑名单、只读拦截都在主进程（redis-command-policy.js / redis-console.js），
 * 这里连"这条能不能执行"的追问都不回答，只把主进程给的原因码翻译成词条
 * （映射表在 common/db-redis-console.js，与补全列表同一份）。
 *
 * 三个界面决定，都不是审美选择：
 *
 * 1) **最新一条在最上面**。执行后不必滚动就能看到结果，也让"在途"的那条一直在视野里；
 *    如果放到底部，弹层越用越像一份需要来回拖的日志。
 * 2) **补全只补命令名**，且 Enter 的含义分两种：列表开着且有高亮 → 补全；否则 → 执行。
 *    两个动作共用一个键是终端用户的直觉（redis-cli 与命令面板都这样），
 *    因此高亮态必须显式可见（`.is-active`），否则回车会做"没看到的那件事"。
 * 3) **错误回复画在历史里**，不弹 toast：`ERR wrong number of arguments` 是服务端
 *    对这条命令的回答，属于结果；只有连接类失败才由 owner 的错误通道处理。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Input, Button, Alert, Empty, Tag } from 'antd'
import { CopyOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import {
  REPLY_VISIBLE_ROWS,
  consoleCandidates,
  applyCompletion,
  consoleReasonKey,
  flattenReply,
  replyHeader,
  replyToText
} from '../../common/db-redis-console'

const e = window.translate

export default function DbRedisConsoleModal (props) {
  const {
    state,
    isReadonly,
    dbIndex,
    onClose,
    onDraftChange,
    onRun,
    onReloadCommands,
    onClearHistory
  } = props
  const s = state || {}
  const history = useMemo(() => (Array.isArray(s.history) ? s.history : []), [s.history])
  const draft = typeof s.draft === 'string' ? s.draft : ''
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(-1)
  // 列表是否显示由"用户有没有主动收起来"决定，而不是每条候选变化都重开：
  // 补全打字时输入会变、候选会变，如果只在候选非空时显示，用户按了 Esc 之后
  // 下一个字符又会把它弹回来
  const [dismissed, setDismissed] = useState(false)
  const inputRef = useRef(null)
  const pendingCaretRef = useRef(null)

  const { ctx, items } = useMemo(() => consoleCandidates({
    entries: s.entries,
    recent: history.map(h => h.line),
    line: draft,
    caret
  }), [s.entries, history, draft, caret])

  const suggestOpen = !dismissed && ctx.active && items.length > 0

  useEffect(() => {
    // 每次打开回到干净的一屏：草稿留着（上一段没敲完的命令），高亮与"已收起"作废
    if (s.open) {
      setActive(-1)
      setDismissed(false)
    }
  }, [s.open])

  useEffect(() => {
    // 候选变了就重新从第一条开始指：高亮留在原下标会指到另一条命令上，
    // 用户按回车补出来的就不是他看到的那个名字
    setActive(-1)
  }, [ctx.token, ctx.isCommand])

  useEffect(() => {
    if (pendingCaretRef.current === null) {
      return
    }
    const el = inputRef.current && inputRef.current.input
    const at = pendingCaretRef.current
    pendingCaretRef.current = null
    if (el) {
      el.focus()
      el.setSelectionRange(at, at)
      setCaret(at)
    }
  }, [draft])

  const accept = item => {
    const next = applyCompletion(draft, caret, item.insert)
    pendingCaretRef.current = next.caret
    onDraftChange(next.line)
    setActive(-1)
  }

  const onChange = ev => {
    onDraftChange(ev.target.value)
    setCaret(ev.target.selectionStart === null ? ev.target.value.length : ev.target.selectionStart)
    setDismissed(false)
  }

  const onKeyDown = ev => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!items.length) {
        return
      }
      ev.preventDefault()
      setDismissed(false)
      setActive(i => {
        const n = items.length
        if (i < 0) {
          return ev.key === 'ArrowDown' ? 0 : n - 1
        }
        return ev.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n
      })
      return
    }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      if (suggestOpen && active >= 0 && items[active]) {
        accept(items[active])
        return
      }
      onRun(draft)
      return
    }
    if (ev.key === 'Escape') {
      if (suggestOpen) {
        // 只在列表开着时吃掉这次 Esc：否则它该照常关弹层
        ev.stopPropagation()
        setDismissed(true)
        setActive(-1)
      }
    }
  }

  const renderRow = r => (
    <div
      key={r.id}
      className='db-redis-console-row'
      style={{ paddingLeft: 8 + r.depth * 14 }}
    >
      {
        r.label
          ? <span className='db-redis-console-row-label'>{r.label}</span>
          : null
      }
      <span className={`db-redis-console-value is-${r.kind}`}>{r.text}</span>
    </div>
  )

  const renderEntry = h => {
    const res = h.res || {}
    const tone = h.pending
      ? 'pending'
      : (h.ipcError ? 'conn' : (res.status || 'pending'))
    // 回复分型只做一次：flattenReply 走的是整棵回复树，一条记录画两遍
    // （rows 与 rowsTruncated 各一次）在几千项的回复上是能感觉出来的
    const flat = tone === 'ok' ? flattenReply(res.reply) : null
    return (
      <div className={`db-redis-console-entry is-${tone}`} key={`h${h.id}`}>
        <div className='db-redis-console-cmd'>
          <span className='db-redis-console-cmd-text'>{h.line}</span>
          {
            h.pending
              ? <Tag className='db-redis-console-tag'>{e('dbRedisConsolePending')}</Tag>
              : null
          }
          {
            // "写"标记来自服务端自述（主进程随结果一起交下），只用来提醒
            // "键列表可能已经过期"，不参与任何判定
            res.write === true
              ? <Tag color='orange' className='db-redis-console-tag'>{e('dbRedisConsoleWriteTag')}</Tag>
              : null
          }
          {
            typeof res.elapsedMs === 'number'
              ? <span className='db-redis-console-ms'>{`${res.elapsedMs} ms`}</span>
              : null
          }
          {
            tone === 'ok'
              ? (
                <Button
                  type='text'
                  size='small'
                  className='db-redis-console-copy'
                  icon={<CopyOutlined />}
                  title={e('copy')}
                  aria-label={e('copy')}
                  onClick={() => copy(replyToText(res.reply))}
                />
                )
              : null
          }
        </div>
        {
          // 连接/超时类失败：不是"回复"，原文已由 cleanDbError 去过栈噪声
          h.ipcError
            ? <Alert type='error' showIcon message={h.ipcError} className='db-redis-console-alert' />
            : null
        }
        {
          tone === 'invalid' || tone === 'blocked'
            ? (
              <Alert
                type='warning'
                showIcon
                className='db-redis-console-alert'
                message={e(consoleReasonKey(res.reason))}
                description={e('dbRedisConsoleBlockedBy')}
              />
              )
            : null
        }
        {
          tone === 'error'
            ? (
              <div className='db-redis-console-error'>
                <span className='db-redis-console-prefix'>Redis</span>
                {res.error}
              </div>
              )
            : null
        }
        {
          flat
            ? (
              <div className='db-redis-console-reply'>
                <div className='db-redis-console-header'>{replyHeader(res.reply, e)}</div>
                {flat.rows.map(renderRow)}
                {
                  // 两种"看不全"必须分开说：主进程截的是 IPC 之前的数据（真的没拿回来），
                  // 这里截的只是没画出来（复制按钮给得出完整值）
                  res.truncated
                    ? <div className='db-redis-console-note'>{e('dbRedisConsoleMainTruncated')}</div>
                    : null
                }
                {
                  flat.rowsTruncated
                    ? (
                      <div className='db-redis-console-note'>
                        {e('dbRedisConsoleRowsTruncated').replace('{n}', String(REPLY_VISIBLE_ROWS))}
                      </div>
                      )
                    : null
                }
                {
                  // 判定属性来自回落名单而不是 COMMAND：只读位下的拒绝理由会不同，
                  // 这一条得让用户知道列表不是权威口径
                  res.source === 'fallback'
                    ? <div className='db-redis-console-note'>{e('dbRedisConsoleFallbackSource')}</div>
                    : null
                }
                {
                  res.write === true
                    ? <div className='db-redis-console-note'>{e('dbRedisConsoleWriteNote')}</div>
                    : null
                }
              </div>
              )
            : null
        }
      </div>
    )
  }

  return (
    <Modal
      open={!!s.open}
      title={`${e('dbRedisConsole')}${typeof dbIndex === 'number' ? ` · db ${dbIndex}` : ''}`}
      // 命令与回复都是等宽内容，窄了会把一行回复折成三行读不出边界
      width={860}
      className='db-redis-console'
      onCancel={onClose}
      footer={[
        <Button key='clear' size='small' icon={<DeleteOutlined />} onClick={onClearHistory} disabled={!history.length}>
          {e('dbRedisConsoleClear')}
        </Button>,
        <Button
          key='reload'
          size='small'
          icon={<ReloadOutlined />}
          loading={!!s.listLoading}
          onClick={() => onReloadCommands(true)}
        >
          {e('dbRedisConsoleReload')}
        </Button>,
        // 没有"关闭"以外的动作：控制台里唯一执行东西的入口是回车/执行按钮，
        // 页脚再放一个"执行"等于给同一次操作两个位置
        <Button key='close' size='small' onClick={onClose}>
          {e('close')}
        </Button>
      ]}
    >
      {
        isReadonly
          ? (
            <Alert
              type='info'
              showIcon
              className='db-redis-console-mode'
              message={e('dbRedisConsoleReadonly')}
            />
            )
          : null
      }
      {
        s.listError
          ? (
            <Alert
              type='warning'
              showIcon
              className='db-redis-console-mode'
              message={`${e('dbRedisConsoleNoCommandList')}：${s.listError}`}
            />
            )
          : null
      }
      <div className='db-redis-console-input'>
        <Input
          ref={inputRef}
          className='db-redis-console-line'
          value={draft}
          placeholder={e('dbRedisConsolePlaceholder')}
          onChange={onChange}
          onKeyDown={onKeyDown}
          // 不带清除叉：清空用 Ctrl+A + Delete 就行，而这个框右侧要留给补全列表的
          // 定位边界，多一个悬浮图标会让"最后一个字符"和"清除"重叠
          allowClear={false}
        />
        <Button
          type='primary'
          size='small'
          className='db-redis-console-run'
          onClick={() => onRun(draft)}
          disabled={!String(draft).trim()}
        >
          {e('dbRedisConsoleRun')}
        </Button>
      </div>
      {
        suggestOpen
          ? (
            <div className='db-redis-console-suggest'>
              {
                items.map((it, i) => (
                  <div
                    key={it.id}
                    className={
                      'db-redis-console-suggest-item' +
                      (i === active ? ' is-active' : '') +
                      (it.blocked ? ' is-blocked' : '')
                    }
                    // 用 onMouseDown：blur 会先于 click 发生，列表在 click 之前就被
                    // 自己的失焦收掉了，于是鼠标点永远补不进去
                    onMouseDown={ev => {
                      ev.preventDefault()
                      accept(it)
                    }}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span className='db-redis-console-suggest-name'>{it.title}</span>
                    {
                      it.subtitle
                        ? <span className='db-redis-console-suggest-flags'>{it.subtitle}</span>
                        : null
                    }
                    {
                      // 提示来自服务端 readOnlyHint，与执行判定同源：这里画的就是
                      // "按回车会发生什么"，不是另算一遍
                      it.hint
                        ? <span className='db-redis-console-suggest-hint'>{e(it.hint)}</span>
                        : null
                    }
                  </div>
                ))
              }
            </div>
            )
          : null
      }
      <div className='db-redis-console-history'>
        {
          history.length
            ? history.map(renderEntry)
            : <Empty description={e('dbRedisConsoleHistoryEmpty')} />
        }
      </div>
    </Modal>
  )
}
