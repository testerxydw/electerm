/**
 * 数据库会话页的"页面内查找"（顶栏搜索条）—— 从 db-session.jsx 拆出的第二段（N11a 第 2 步）。
 *
 * 命中清单有三个来源，且必须始终与"能定位到的位置"一致：
 * - `.db-kw-hit` DOM 标记（网格、结果集、结构页渲染时打的 span）；
 * - textarea 里的文本命中（值面板编辑态）——textarea 的 value 变化不产生 DOM mutation，
 *   所以除 MutationObserver 外还要 input 事件委托补算；
 * - SQL 编辑器（CM6）的全文命中——它只把可视行渲染进 DOM，数量只能问编辑器要。
 *
 * 边界：两个 ref 由页面自己持有并传进来。`bodyRef` 是查找扫描的容器，
 * `sqlEditorRef` 除了这里还有十几处（插入/取值/回填）在用，不属于查找。
 * 行为零变更：整段是从 db-session.jsx 原样搬过来的（连缩进层级都一样），
 * 判据与注释没重写。
 */
import { useEffect, useRef, useState } from 'react'
import { scanTextHits, cycleIndex } from './db-search'

export function useDbPageSearch ({ bodyRef, sqlEditorRef }) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchHits, setSearchHits] = useState(0)
  // 当前命中序号（0 基）：上一个/下一个循环导航 + 当前命中两色/滚动定位。
  // ref 镜像供 recount（rAF 回调）与 goHit 读取最新值，避开 setState 闭包过期
  const [searchIndex, setSearchIndex] = useState(0)
  const searchIndexRef = useRef(0)
  // 命中清单 ref：DOM 标记数组 + textarea 文本命中 + SQL 编辑器命中数
  // （编辑器是 CM6，只有可视行在 DOM 里，命中数由编辑器自己按全文算，见 A-1）
  const hitsRef = useRef({ marks: [], taHits: [], sqlHits: 0 })

  const setIdx = (v) => {
    searchIndexRef.current = v
    setSearchIndex(v)
  }

  // 仅切换 DOM 当前命中的 .db-kw-cur 类（不滚动、不抢焦点；recount 与渲染后共用）
  const applyMarks = (index) => {
    const { marks } = hitsRef.current
    marks.forEach((el, i) => el.classList.toggle('db-kw-cur', i === index))
  }

  // 导航定位（仅 goHit 调用）：DOM 命中滚动到可视区；textarea 命中 focus +
  // setSelectionRange；SQL 编辑器命中交给编辑器自己 dispatch 选区（CM6 只渲染可视行，
  // 它是唯一能按全文偏移定位的人）
  const locateHit = (index) => {
    const { marks, taHits, sqlHits } = hitsRef.current
    applyMarks(index)
    if (index < marks.length) {
      const cur = marks[index]
      if (cur && cur.isConnected) {
        cur.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
      return
    }
    const taIndex = index - marks.length
    if (taIndex < taHits.length) {
      const hit = taHits[taIndex]
      if (hit && hit.el.isConnected) {
        hit.el.focus()
        hit.el.setSelectionRange(hit.start, hit.end)
        hit.el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
      return
    }
    const editor = sqlEditorRef.current
    if (editor && sqlHits && taIndex - taHits.length < sqlHits) {
      editor.setSearchKeyword(kw)
      editor.selectSearchHit(taIndex - taHits.length)
    }
  }
  const kw = searchText.trim().toLowerCase()

  // 命中清单 = 页面 .db-kw-hit 标记 + textarea 内文本命中（值面板编辑态）+
  // SQL 编辑器命中（CM6 自己算全文，DOM 里只有可视行）。
  // 用 MutationObserver + input 事件委托跟随内容变化重算，计数与可定位位置永远一致。
  useEffect(() => {
    const root = bodyRef.current
    if (!root) {
      return
    }
    let raf = 0
    const recount = () => {
      window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(() => {
        const marks = Array.from(root.querySelectorAll('.db-kw-hit'))
        const taHits = []
        let sqlHits = 0
        if (kw) {
          root.querySelectorAll('textarea').forEach(ta => {
            scanTextHits(ta.value, kw).forEach(h => {
              taHits.push({ el: ta, start: h.start, end: h.end })
            })
          })
          // CM6 只把可视行渲染进 DOM，命中必须问编辑器要全文结果
          if (sqlEditorRef.current) {
            sqlHits = sqlEditorRef.current.getSearchHits(kw).length
          }
        }
        hitsRef.current = { marks, taHits, sqlHits }
        const total = marks.length + taHits.length + sqlHits
        setSearchHits(total)
        // 内容变化导致命中减少时收敛当前序号，避免越界；同步刷新当前命中标记
        const cur = total ? Math.min(searchIndexRef.current, total - 1) : 0
        setIdx(cur)
        applyMarks(cur)
      })
    }
    recount()
    const ob = new window.MutationObserver(recount)
    ob.observe(root, { childList: true, subtree: true, characterData: true })
    // textarea 的 value 变化不产生 DOM mutation，靠 input 事件委托补算
    root.addEventListener('input', recount, true)
    return () => {
      ob.disconnect()
      root.removeEventListener('input', recount, true)
      window.cancelAnimationFrame(raf)
    }
  }, [kw])

  // 换关键字时回到第一个命中
  useEffect(() => {
    setIdx(0)
  }, [kw])

  // 渲染后同步当前命中：DOM 标记类 + （仅 DOM 命中）滚动到可视区。
  // 切词瞬间 hitsRef 可能还是旧清单（rAF recount 未跑），但 detached 元素操作无害，
  // recount 回调会按新清单重标；textarea 定位只在 goHit 里做，避免切词时抢搜索框焦点
  useEffect(() => {
    const root = bodyRef.current
    if (!root) {
      return
    }
    const { marks } = hitsRef.current
    marks.forEach((el, i) => el.classList.toggle('db-kw-cur', i === searchIndex))
    const cur = marks[searchIndex]
    if (cur && cur.isConnected) {
      cur.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [searchIndex, searchHits, kw])

  // 上一个/下一个：循环导航（与终端查找同交互；命中含 textarea 与编辑器内文本）
  const goHit = (delta) => {
    const { marks, taHits, sqlHits } = hitsRef.current
    const n = marks.length + taHits.length + sqlHits
    if (!n) {
      return
    }
    const next = cycleIndex(searchIndexRef.current, delta, n)
    setIdx(next)
    locateHit(next)
  }

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchText('')
    setIdx(0)
  }

  return {
    searchOpen,
    setSearchOpen,
    searchText,
    setSearchText,
    searchHits,
    searchIndex,
    kw,
    goHit,
    closeSearch
  }
}
