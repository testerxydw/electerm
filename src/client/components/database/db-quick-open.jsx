/**
 * E2-3b 命令面板（Ctrl/Cmd+K）：四类来源的分组速选浮层。
 * （设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.5 附带项）
 *
 * 职责切分：
 * - 打分 / 稳定排序 / 截断 / 分组全在纯函数层 db-quick-open.js（单测钉死口径），
 *   这里只消费 rankItems + groupItems，不重复实现任何匹配逻辑；
 * - 四类来源（动作 / 对象 / 历史前 20 / 当前表相关）由父组件归一成
 *   { kind, id, title, subtitle, hint, run } 传进来，本组件不读任何 store ——
 *   数据从哪来、run 干什么，都是父组件的事。
 *
 * 交互边界：
 * - 受控开关：open=false 时返回 null，不渲染也不挂监听 —— 浮层常驻 DOM
 *   会截走焦点与滚动，还会让 Esc 语义变得含糊；
 * - 键盘 ↑↓ 在跨组扁平序（动作全部 → 对象全部 → 历史全部）里循环移动，
 *   Enter 执行当前项，Esc 关闭；鼠标 hover 同步高亮，点击执行；
 * - run 的同步异常在这里 catch 住不让面板崩：各类 run 自带报错通道
 *   （onOpError / message.error），异步失败的 catch 也在 run 自己的实现里，
 *   这里再弹一次错只会出现双重提示。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from 'antd'
import { rankItems, groupItems } from '../../common/db-quick-open'

const e = window.translate

// 三组渲染顺序与组头词条：这也是空 query 下的默认清单顺序
// （纯函数层按类型权重已把 动作→对象→历史 排在前面，分组顺序只是展示投影）
const GROUPS = [
  { kind: 'action', labelKey: 'dbQuickOpenGroupAction' },
  { kind: 'object', labelKey: 'dbQuickOpenGroupObject' },
  { kind: 'history', labelKey: 'dbQuickOpenGroupHistory' }
]

export default function DbQuickOpen ({ open, onClose, items, placeholder }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // 每次打开都重置 query：按 Ctrl+K 的肌肉记忆是"列出全部可选项"，
  // 带着上一次的筛选词打开，面板会呈现成"一打开就是过滤后的残表"
  useEffect(() => {
    if (!open) {
      return undefined
    }
    setQuery('')
    setIndex(0)
    // 延迟一拍再聚焦：与历史弹层 openSqlHistory 同一手法，
    // 避免与打开瞬间的重渲染抢焦点
    const timer = setTimeout(() => {
      const el = inputRef.current
      if (el && el.focus) {
        el.focus()
      }
    }, 60)
    return () => clearTimeout(timer)
  }, [open])

  const ranked = useMemo(() => rankItems(items, query), [items, query])
  const groups = useMemo(() => groupItems(ranked), [ranked])
  // 键盘导航的扁平序 = 三组按渲染顺序拼接（动作全部 → 对象全部 → 历史全部），
  // 与视觉顺序一致：↑↓ 走的顺序就是眼睛看到的顺序
  const flat = useMemo(
    () => [...groups.action, ...groups.object, ...groups.history],
    [groups]
  )

  // 结果集收缩时夹住当前序号，避免 ↑↓/Enter 指向已经消失的条目
  useEffect(() => {
    setIndex(cur => Math.min(cur, Math.max(0, flat.length - 1)))
  }, [flat.length])

  // 当前条目滚动进可视区：键盘走查时列表可能比面板高
  useEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const cur = list.querySelector('.db-quick-open-cur')
    if (cur && cur.scrollIntoView) {
      cur.scrollIntoView({ block: 'nearest' })
    }
  }, [index, open])

  if (!open) {
    return null
  }

  const runEntry = (entry) => {
    if (!entry || !entry.item || typeof entry.item.run !== 'function') {
      return
    }
    try {
      entry.item.run()
    } catch (err) {
      // 只兜底同步异常不让面板崩；报错通道在 run 自己的实现里
      console.warn('db quick open run failed:', err)
    }
    onClose()
  }

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      onClose()
      return
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      if (!flat.length) {
        return
      }
      const delta = ev.key === 'ArrowDown' ? 1 : -1
      // 循环导航：到头回到另一端，与历史面板的键盘走查同一手感
      setIndex(cur => (cur + delta + flat.length) % flat.length)
      return
    }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      runEntry(flat[index])
    }
  }

  // 各组在扁平序里的起点：hover/渲染时把"组内下标"换算成全局下标，
  // 不在渲染里做闭包累加（那种写法在 React 并发特性下会算错）
  const offsets = {
    action: 0,
    object: groups.action.length,
    history: groups.action.length + groups.object.length
  }

  return (
    <div
      className='db-quick-open-mask'
      onMouseDown={onClose}
    >
      <div
        className='db-quick-open'
        onMouseDown={ev => ev.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <Input
          className='db-quick-open-input'
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          onChange={ev => setQuery(ev.target.value)}
          allowClear
        />
        <div className='db-quick-open-list' ref={listRef}>
          {GROUPS.map(g => {
            const entries = groups[g.kind]
            if (!entries.length) {
              return null
            }
            return (
              <div className='db-quick-open-group' key={g.kind}>
                <div className='db-quick-open-group-title'>{e(g.labelKey)}</div>
                {entries.map((entry, j) => {
                  const i = offsets[g.kind] + j
                  return (
                    <div
                      key={`${g.kind}:${entry.item.id || entry.item.title}:${i}`}
                      className={'db-quick-open-item' + (i === index ? ' db-quick-open-cur' : '')}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => runEntry(entry)}
                    >
                      <div className='db-quick-open-item-main'>
                        <span className='db-quick-open-item-title'>{entry.item.title}</span>
                        {
                          entry.item.subtitle
                            ? <span className='db-quick-open-item-sub'>{entry.item.subtitle}</span>
                            : null
                        }
                      </div>
                      {
                        entry.item.hint
                          ? <span className='db-quick-open-item-hint'>{entry.item.hint}</span>
                          : null
                      }
                    </div>
                  )
                })}
              </div>
            )
          })}
          {
            flat.length
              ? null
              : <div className='db-quick-open-empty'>{e('noMatches')}</div>
          }
        </div>
      </div>
    </div>
  )
}
