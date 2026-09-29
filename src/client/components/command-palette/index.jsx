/**
 * command palette (Ctrl/Cmd + K)
 * 快速跳转会话 / 执行动作；独立监听快捷键，不改动 shortcuts 体系
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { auto } from 'manate/react'
import { filterItems } from './filter'
import './index.styl'

const e = window.translate

export default auto(function CommandPalette (props) {
  const { store } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)

  const items = useMemo(() => {
    const tabs = (store.tabs || []).map(t => ({
      kind: 'tab',
      id: t.id,
      batch: t.batch,
      label: t.title || t.host || t.id,
      keywords: `${t.host || ''} ${t.id || ''}`,
      hint: '会话'
    }))
    const actions = [
      {
        kind: 'action',
        action: 'newSsh',
        label: e('newTab') || 'New session',
        keywords: 'new ssh tab connect session 新建 会话',
        hint: '动作'
      }
    ]
    return [...tabs, ...actions]
  }, [store.tabs])

  const filtered = useMemo(() => filterItems(items, query), [items, query])

  useEffect(() => {
    const onKey = (ev) => {
      const key = (ev.key || '').toLowerCase()
      if ((ev.ctrlKey || ev.metaKey) && key === 'k') {
        ev.preventDefault()
        setOpen(v => !v)
        setQuery('')
        setIndex(0)
        return
      }
      if (!open) {
        return
      }
      if (key === 'escape') {
        setOpen(false)
      } else if (key === 'arrowdown') {
        ev.preventDefault()
        setIndex(i => Math.min(i + 1, Math.max(0, filtered.length - 1)))
      } else if (key === 'arrowup') {
        ev.preventDefault()
        setIndex(i => Math.max(i - 1, 0))
      } else if (key === 'enter') {
        ev.preventDefault()
        run(filtered[index])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, index])

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  // 供外部入口（标题栏/标签栏按钮）唤出
  useEffect(() => {
    const onOpen = () => {
      setOpen(true)
      setQuery('')
      setIndex(0)
    }
    window.addEventListener('open-command-palette', onOpen)
    return () => window.removeEventListener('open-command-palette', onOpen)
  }, [])

  function run (it) {
    if (!it) {
      return
    }
    setOpen(false)
    if (it.kind === 'tab') {
      window.store.clickTab(it.id, it.batch)
    } else if (it.kind === 'action' && it.action === 'newSsh') {
      window.store.onNewSsh()
    }
  }

  if (!open) {
    return null
  }

  return (
    <div className='cmd-palette-mask' onMouseDown={() => setOpen(false)}>
      <div
        className='cmd-palette'
        onMouseDown={ev => ev.stopPropagation()}
      >
        <div className='cmd-palette-pin'>
          <span className='cmd-palette-ico'>⌘</span>
          <input
            ref={inputRef}
            className='cmd-palette-input'
            value={query}
            placeholder='搜索会话、动作…'
            onChange={ev => {
              setQuery(ev.target.value)
              setIndex(0)
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className='cmd-palette-list'>
          {filtered.length === 0 && (
            <div className='cmd-palette-empty'>无匹配项</div>
          )}
          {filtered.map((it, i) => (
            <div
              key={`${it.kind}-${it.id || it.action}`}
              className={'cmd-palette-item' + (i === index ? ' sel' : '')}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(it)}
            >
              <span className='cmd-palette-hint'>{it.hint}</span>
              <span className='cmd-palette-label elli'>{it.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})
