/**
 * H1a-2：5 处网格共用的列宽控制（拖拽手柄 + 列头菜单 + 工具行"自适应全部列"）
 *
 * 为什么抽到这里：SQL 结果 / 表结构 / Redis 键列表 / Redis 详情原来是各自写死的
 * `width: 220 / 200 / 90 / 150`，只有数据页能拖。可读性统一层的第 2 步要让 5 处
 * 用同一套"宽度四源优先级 + 同一个手柄 + 同一个菜单"，所以机构收在一处：
 * - 纯决策（夹取、优先级、手动宽增删）在 common/db-column-width.js，可单测；
 * - 这里只做"事件 → 状态"的薄层，不掺量宽公式，也不决定"这一列该多宽"
 *   （加宽的目标宽由调用点在点击时算，避免为所有列预扫一遍宽版）。
 *
 * 列头菜单是**全站单例**（整个 db 会话只挂一个浮层）：给每列各挂一个 Dropdown 的话，
 * 200 列的数据页每次列 memo 重建都要挂/卸上百个 Trigger 实例；单例只有一份状态，
 * 列本身只负责"打开时把落点写进 state"。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Popover } from 'antd'
import {
  clampDragWidth,
  pickColumnWidth,
  withManualWidth,
  withoutManualWidth,
  COL_W_WIDE,
  COL_W_FALLBACK
} from '../../common/db-column-width'

const e = window.translate

// 菜单三项：前两项作用于这一列，第三项作用于整个网格（与工具行按钮同一动作）
const MENU_ACTIONS = [
  { key: 'auto', label: 'dbColAutoFit' },
  { key: 'wide', label: 'dbColWiden' },
  { key: 'all', label: 'dbColAutoFitAll' }
]

/**
 * 一个网格的列宽状态。
 *
 * @param {Object} opts
 * @param {Object}   opts.manual   手动宽 map（拖过/加宽过的列）：{ [key]: width }
 * @param {Function} opts.commit   (updater) => void；updater 拿**最新** map 返回新 map。
 *                                 必须走 updater：菜单/拖拽结束若读渲染闭包里的 map，
 *                                 会把中间的其他改动一起覆盖掉
 * @param {Object}   opts.fitted   自适应宽 map（90~360），调用方按行 memo
 * @param {number}   opts.fallback 三源都空时的兜底宽
 * @returns {Object} live / widthOf / startResize / setCol / clearCol / clearAllCols / hasManual
 *
 * ⚠️ 返回值里的函数每轮渲染都是新引用，**不能**进列 memo 的依赖数组（那样等于没 memo）。
 * 依赖只放 `live`、`manual`、`fitted` 这些状态量 —— 与数据页原来依赖 liveWidth 同理。
 */
export function useColWidths (opts) {
  const {
    manual,
    commit,
    fitted,
    fallback = COL_W_FALLBACK
  } = opts

  // 拖拽中的实时宽度：state 驱动渲染（要看得见变宽），ref 镜像给 mouseup 读终值
  // （原生监听里闭包拿到的 state 会过期）。拖拽过程不 commit —— mousemove 每帧
  // 提交会把一次拖拽放大成几十次写持久化视角 + 列清单重算
  const [live, setLive] = useState(null)
  const liveRef = useRef(null)
  const commitRef = useRef(commit)
  commitRef.current = commit

  const startResize = useCallback((ev, key) => {
    // 别触发表头排序（点击会冒泡到 th）
    ev.preventDefault()
    ev.stopPropagation()
    const th = ev.currentTarget && ev.currentTarget.closest
      ? ev.currentTarget.closest('th')
      : null
    // 起点用 th 的实测宽，而不是配置宽：table-layout fixed + max-content 会把
    // 剩余空间摊给各列，配置宽 90 的列实际可能显示成 240 —— 从实测宽起算，
    // 按下第一帧就不会"跳"到配置值（配置宽只作为量不到 th 时的兜底）
    const configured = pickColumnWidth({
      manual: (manual || {})[key],
      fitted: (fitted || {})[key],
      fallback
    })
    const measured = th ? Math.round(th.getBoundingClientRect().width) : 0
    const base = measured > 0 ? measured : configured
    const startX = ev.clientX
    const move = (mouseEv) => {
      const w = clampDragWidth(base, mouseEv.clientX - startX)
      liveRef.current = { key, width: w }
      setLive({ key, width: w })
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.classList.remove('db-col-resizing')
      const cur = liveRef.current
      liveRef.current = null
      setLive(null)
      if (cur) {
        commitRef.current(m => withManualWidth(m, cur.key, cur.width))
      }
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    document.body.classList.add('db-col-resizing')
  }, [manual, fitted, fallback])

  const setCol = useCallback((key, width) => {
    commitRef.current(m => withManualWidth(m, key, width))
  }, [])

  // "自适应本列/全部列"就是把手动宽删掉：自适应值本来每次行集变化都重算，
  // 没有"存一份自适应结果"的必要，删掉即回到它
  const clearCol = useCallback((key) => {
    commitRef.current(m => withoutManualWidth(m, key))
  }, [])

  const clearAllCols = useCallback(() => {
    commitRef.current(() => ({}))
  }, [])

  const widthOf = (key) => pickColumnWidth({
    live: live && live.key === key ? live.width : 0,
    manual: (manual || {})[key],
    fitted: (fitted || {})[key],
    fallback
  })

  return {
    live,
    widthOf,
    startResize,
    setCol,
    clearCol,
    clearAllCols,
    hasManual: !!manual && Object.keys(manual).length > 0,
    fallback
  }
}

/**
 * 列头菜单浮层的开关（全站单例，整个 db 会话只挂一份 DbColMenu）。
 * 打开时记下"哪一列 + 该列所属网格的宽度状态 + 这一列加宽的目标宽 + 落点坐标"
 * （调用点可另给 head 当菜单标题），之后菜单项怎么落库全在 DbColMenu 里按 target
 * 分派，调用方不再需要提供回调。
 *
 * `wide` 在打开时算一次（右键是低频动作，扫一遍 ≤100 行的采样换的是"菜单里的
 * 数字就是点下去会变成的宽度"，而不是等点击时再算一遍导致标签与结果不一致）。
 */
export function useColMenu () {
  const [target, setTarget] = useState(null)
  const hide = useCallback(() => setTarget(null), [])

  // onContextMenu 挂在列定义的 onHeaderCell 上（rc-table 把未知 props 原样摊到 th）。
  // 落点取 th 的左下角：菜单贴着被右键的那一列往下展开，视线不用找。
  // 矩形必须在 handler 里同步读：React 事件对象在 handler 返回后就失效
  const openColMenu = useCallback((ev, opts) => {
    ev.preventDefault()
    ev.stopPropagation()
    const el = ev.currentTarget
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null
    setTarget({
      ...opts,
      x: r ? Math.round(r.left) : -1,
      y: r ? Math.round(r.bottom) : -1
    })
  }, [])

  return { target, openColMenu, hide }
}

/**
 * 列头标题节点：列名（+可选注释第二行）+ 拖拽手柄（+可选排序）。
 * 手柄复用数据页既有的 .db-col-resizer（th 右边沿 16px 热区，hover 才显竖线），
 * 所以 5 处网格的拖拽手感是同一个。
 *
 * 排序不走 antd 的 sorter：它会把标题包进 `.ant-table-column-sorters`，列头就从
 * "整格都是拖拽手柄的宿主"缩成"标题那一小段"，右沿热区跟着跑偏。这里自己接
 * 点击/Enter/空格，状态由调用方受控（`sort` 为 null / 'ascend' / 'descend'）。
 */
export function ColHead (props) {
  const {
    label, colKey, wg, comment, hint,
    sort = null, onSort,
    className = 'db-col-head'
  } = props
  const sortable = typeof onSort === 'function'
  // 这一次点击的 mousedown 是不是落在拖宽手柄上。拖宽时列在指针下变宽，抬起点
  // 往往还在同一列里，浏览器把 click 派发到"按下与抬起的共同祖先"（就是列头），
  // 于是每一次拖完都白送一次排序点击（CDP 实测：拖一次 __orders 多一条 id:asc）
  const pressedOnHandle = useRef(false)
  const clearPressed = () => { pressedOnHandle.current = false }
  const onHeadClick = () => {
    if (pressedOnHandle.current) {
      pressedOnHandle.current = false
      return
    }
    onSort()
  }
  const onKeyDown = sortable
    ? ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        ev.stopPropagation()
        onSort()
      }
    }
    : undefined
  return (
    <span
      className={className + (sortable ? ' db-col-head-sortable' : '')}
      title={hint || (typeof label === 'string' ? label : undefined)}
      role={sortable ? 'button' : undefined}
      tabIndex={sortable ? 0 : undefined}
      aria-sort={
        sortable
          ? (sort === 'ascend' ? 'ascending' : sort === 'descend' ? 'descending' : 'none')
          : undefined
      }
      // 在列名上按下 = 这是一次真点击，把手柄留下的标记清掉（标记只在拖的那次生效）
      onMouseDown={sortable ? clearPressed : undefined}
      onClick={sortable ? onHeadClick : undefined}
      onKeyDown={onKeyDown}
    >
      <span className='db-col-name'>{label}</span>
      {
        comment
          ? <span className='db-col-comment' title={comment}>{comment}</span>
          : null
      }
      {
        sortable
          ? (
            <span
              className={'db-col-sort' + (sort ? ' db-col-sort-active' : '')}
              aria-hidden='true'
            >
              {sort === 'ascend' ? '▲' : sort === 'descend' ? '▼' : '⇅'}
            </span>
            )
          : null
      }
      {/* 手柄不吃点击/双击/右键：点一下会误触排序，右键要留给列头菜单（在 th 上） */}
      <span
        className='db-col-resizer'
        onMouseDown={ev => {
          pressedOnHandle.current = true
          wg.startResize(ev, colKey)
        }}
        onClick={ev => ev.stopPropagation()}
        onDoubleClick={ev => ev.stopPropagation()}
        onContextMenu={ev => ev.stopPropagation()}
      />
    </span>
  )
}

/**
 * 单例列头菜单：内容是三行按钮（原生 button → Tab/Enter 天然可用）。
 * 关闭时机与预览卡同一套：选中一项、Esc、任何滚动、在别处按下。
 */
export function DbColMenu (props) {
  const { target, onHide } = props
  const popRef = useRef(null)

  useEffect(() => {
    if (!target) {
      return
    }
    const onDown = (ev) => {
      const el = popRef.current
      // 菜单开着时在别处按下（含再次右键另一列）先收起。
      // 再次右键的顺序是 pointerdown → contextmenu，所以收起后会在新的那一列重开
      if (el && !el.contains(ev.target)) {
        onHide()
      }
    }
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        onHide()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onHide, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onHide, true)
    }
  }, [target, onHide])

  // 菜单标题：优先调用点给的显示名 —— Redis 列头是译文、SQL 的宽度键带
  // 「结果集下标::」前缀，直接显示列键会让用户看到内部键名
  const headText = target ? String(target.head || target.key) : ''

  // 三项都只动"手动宽"这一层：自适应值不入库（每次行集变化重算），
  // 所以"自适应本列/全部列"就是删掉手动宽
  const pick = (action) => {
    if (!target) {
      return
    }
    const { wg, key, wide } = target
    if (action === 'auto') {
      wg.clearCol(key)
    } else if (action === 'wide') {
      wg.setCol(key, wide)
    } else {
      wg.clearAllCols()
    }
    onHide()
  }

  return (
    <Popover
      open={!!target}
      trigger={[]}
      placement='bottomLeft'
      // 关闭即卸载：与预览卡同理，DOM 里不留"藏起来的上一次菜单"，
      // "菜单在不在 DOM"才是可信的实测判据
      destroyOnHidden
      content={
        target
          ? (
            <div className='db-col-menu' ref={popRef}>
              <div className='db-col-menu-head' title={headText}>
                {headText}
              </div>
              {
                MENU_ACTIONS.map(a => (
                  <button
                    type='button'
                    key={a.key}
                    className={'db-col-menu-item db-col-menu-' + a.key}
                    onClick={() => pick(a.key)}
                  >
                    {a.key === 'wide'
                      ? e('dbColWiden').replace('{n}', target.wide || COL_W_WIDE)
                      : e(a.label)}
                  </button>
                ))
              }
            </div>
            )
          : null
      }
    >
      {/* 锚点尺寸规则同预览卡：fixed 元素 offsetParent 恒为 null，0×0 会被
          rc-trigger 判成"不可见"，浮层就永远停在 -1000vw/-1000vh 待定位坐标 */}
      <span
        className='db-col-menu-anchor'
        style={{ left: target ? target.x : -1, top: target ? target.y : -1 }}
      />
    </Popover>
  )
}
