/**
 * H3b-3：ER 图（结构页工具条 → 全屏弹层）
 *
 * 只读视图：取数在 db-session（打开时拉一次 listForeignKeys），布局在
 * common/db-er-layout.js（纯函数，同一份 schema 每次都是同一张图）。这里只负责画和交互。
 *
 * 三条"不猜"：
 * - 表多到超上限时只画有外键关联的表，并把截断写在提示条上 —— 静默丢表
 *   会让人以为那张表不存在；
 * - 没有外键也照常画节点（表本身是事实），只是没有边；
 * - 拖拽只改本地坐标，刷新/重置回到布局函数的确定位置，不写回任何存储。
 *
 * 交互全部走 mouse 事件而不是 pointer capture：capture 会把后续 click 重定向到
 * 捕获元素上，节点的单击/双击就收不到了。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Alert, Spin } from 'antd'
import { ReloadOutlined, UndoOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { layoutErGraph } from '../../common/db-er-layout'

const e = window.translate
const ZOOM_MIN = 0.2
const ZOOM_MAX = 3
const DRAG_THRESHOLD = 3
// 节点宽是按表名长度估的（db-er-layout），这里只负责把超长名字截成省略号；
// SVG 的 text 没有 text-overflow，不截就会画出框外
const LABEL_MAX = 30

function labelOf (name) {
  const s = String(name || '')
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + '…' : s
}

export default function DbErView (props) {
  const { open, loading, error, graph, database, onClose, onRefresh, onOpenTable } = props
  const layout = useMemo(() => layoutErGraph(graph || {}), [graph])
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
  // 拖拽出来的位置只存在这张图的生命周期里：{ [nodeId]: {x, y} }
  const [offsets, setOffsets] = useState({})
  const [hover, setHover] = useState('')
  const [selected, setSelected] = useState('')
  const [dragging, setDragging] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  // 一次拖动结束后紧跟着的那个 click 不该再改变选中：
  // 拖节点是"摆位置"，不是"我要看这张表"
  const draggedRef = useRef(false)
  const fitKeyRef = useRef('')

  // 换图（打开另一个库 / 刷新后表集变了）就把选中和拖动位置清掉：
  // 上一张图的节点 id 不进新图，留着选中会指向一个不存在的节点
  useEffect(() => {
    setSelected('')
    setHover('')
    setOffsets({})
  }, [graph])

  // 画布尺寸：弹层是 85vh 的弹性高度，量出来才能算"铺满屏幕"的初始缩放
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  const fit = useCallback(() => {
    const { w, h } = size
    if (!layout.nodes.length || !w || !h) return
    const pad = 24
    const k = Math.max(ZOOM_MIN, Math.min(1, (w - pad) / layout.width, (h - pad) / layout.height))
    setView({
      k,
      tx: (w - layout.width * k) / 2,
      ty: (h - layout.height * k) / 2
    })
    setOffsets({})
  }, [layout, size])

  // 只在"图变了"和"第一次量到尺寸"时自动铺满：
  // 窗口缩放不该把用户刚拖好的视角弹回原点
  useEffect(() => {
    if (!open) {
      fitKeyRef.current = ''
      return
    }
    if (!size.w || !size.h || !layout.nodes.length) return
    const key = [layout.nodes.length, layout.width, layout.height].join(':')
    if (fitKeyRef.current === key) return
    fitKeyRef.current = key
    fit()
  }, [open, size, layout, fit])

  // React 的 onWheel 是 passive 的，preventDefault 会失效（页面跟着滚）——
  // 缩放必须自己挂一个非 passive 的监听
  useEffect(() => {
    const el = canvasRef.current
    if (!el || !open) return
    const onWheel = ev => {
      ev.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = ev.clientX - rect.left
      const my = ev.clientY - rect.top
      setView(v => {
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * Math.exp(-ev.deltaY * 0.0015)))
        if (k === v.k) return v
        // 以光标为不动点缩放：先求光标在世界坐标里的位置，缩放后再把它放回原屏幕位置
        const scale = k / v.k
        return { k, tx: mx - (mx - v.tx) * scale, ty: my - (my - v.ty) * scale }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open])

  // 拖拽：mouse 事件 + window 级监听，指针移出画布也继续跟手
  const startDrag = (kind, ev, node) => {
    if (ev.button !== 0) return
    const move = me => {
      const dx = me.clientX - ev.clientX
      const dy = me.clientY - ev.clientY
      const d = dragRef.current
      if (!d) return
      if (!d.moved) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
        d.moved = true
        draggedRef.current = true
        setDragging(true)
      }
      if (d.kind === 'pan') {
        setView(v => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }))
      } else {
        // 位移按当前缩放折算：1 屏幕像素 = 1/k 世界单位
        setOffsets(o => ({
          ...o,
          [d.id]: {
            x: Math.round((d.ox + dx / d.k) * 10) / 10,
            y: Math.round((d.oy + dy / d.k) * 10) / 10
          }
        }))
      }
    }
    const up = () => {
      const d = dragRef.current
      if (d) {
        window.removeEventListener('mousemove', d.move)
        window.removeEventListener('mouseup', d.up)
      }
      dragRef.current = null
      setDragging(false)
    }
    dragRef.current = {
      kind,
      id: node ? node.id : '',
      ox: node ? node.x : 0,
      oy: node ? node.y : 0,
      tx: view.tx,
      ty: view.ty,
      k: view.k,
      moved: false,
      move,
      up
    }
    draggedRef.current = false
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  useEffect(() => () => {
    const d = dragRef.current
    if (d) {
      window.removeEventListener('mousemove', d.move)
      window.removeEventListener('mouseup', d.up)
    }
  }, [])

  const nodes = useMemo(() => layout.nodes.map(n => {
    const o = offsets[n.id]
    return o ? { ...n, x: o.x, y: o.y } : n
  }), [layout, offsets])
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  // 高亮口径：悬停优先于选中（hover 是"临时看一眼"，离开就回到选中态）
  const hotId = hover || selected
  const hotNodes = useMemo(() => {
    if (!hotId) return null
    const set = new Set([hotId])
    for (const ed of layout.edges) {
      if (ed.fromId === hotId) set.add(ed.toId)
      if (ed.toId === hotId) set.add(ed.fromId)
    }
    return set
  }, [hotId, layout])
  const hotEdges = useMemo(() => {
    if (!hotId) return null
    const set = new Set()
    layout.edges.forEach((ed, i) => {
      if (ed.fromId === hotId || ed.toId === hotId) set.add(i)
    })
    return set
  }, [hotId, layout])

  const edgePath = ed => {
    const a = byId.get(ed.fromId)
    const b = byId.get(ed.toId)
    if (!a || !b) return ''
    if (a.id === b.id) {
      // 自引用：从右边绕一小圈回来，压在节点上会看起来像没关系
      const x = a.x + a.w
      const y = a.y + a.h / 2
      return `M${x - 18},${y} C${x + 40},${y - 28} ${x + 40},${y + 28} ${x - 18},${y + 8}`
    }
    const x1 = a.x + a.w / 2
    const y1 = a.y + a.h
    const x2 = b.x + b.w / 2
    const y2 = b.y
    const my = (y1 + y2) / 2
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
  }

  const selectedNode = selected ? byId.get(selected) : null
  const selectedEdges = useMemo(() => {
    if (!selected) return []
    return layout.edges.filter(ed => ed.fromId === selected || ed.toId === selected)
  }, [selected, layout])

  const openNode = node => {
    if (!node || !onOpenTable) return
    onOpenTable({
      database,
      schema: node.schema,
      table: node.name,
      nodeType: 'table'
    })
    onClose()
  }

  const truncatedNote = layout.truncated
    ? e('dbErTruncated')
      .replace('{total}', String(layout.total))
      .replace('{kept}', String(layout.kept))
    : ''
  const noFkNote = !loading && !error && layout.nodes.length > 0 && !layout.edges.length
  const empty = !loading && !error && !layout.nodes.length
  const showHint = !error && layout.nodes.length > 0
  const edgeOrder = layout.edges
    .map((ed, i) => ({ ed, hot: !!(hotEdges && hotEdges.has(i)), i }))
    .sort((a, b) => (a.hot === b.hot ? a.i - b.i : a.hot ? 1 : -1))

  return (
    <Modal
      className='db-er-modal'
      open={open}
      width='90%'
      style={{ maxWidth: 1500, top: 40 }}
      title={e('dbErGraph')}
      onCancel={onClose}
      footer={[
        <Button
          key='reset'
          size='small'
          icon={<UndoOutlined />}
          disabled={!layout.nodes.length}
          onClick={fit}
        >
          {e('dbErReset')}
        </Button>,
        <Button key='refresh' size='small' icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          {e('refresh')}
        </Button>,
        <Button key='close' size='small' type='primary' onClick={onClose}>
          {e('close')}
        </Button>
      ]}
    >
      <div className='db-er'>
        {
          // 取数失败的报错放在图上方而不是盖住图：刷新失败时图还是上一次的，
          // 藏着它等于把还能用的东西一起收走
          error
            ? (
              <Alert
                className='db-er-err'
                type='error'
                showIcon
                message={e('dbErFailed')}
                description={error}
              />
              )
            : null
        }
        {
          truncatedNote
            ? <div className='db-er-note'>{truncatedNote}</div>
            : null
        }
        {
          noFkNote
            ? <div className='db-er-note'>{e('dbErNoFk')}</div>
            : null
        }
        {
          showHint
            ? (
              <div className='db-er-head'>
                <span className='db-er-hint'>{e('dbErHint')}</span>
                <span className='db-er-zoom'>{Math.round(view.k * 100)}%</span>
              </div>
              )
            : null
        }
        <div
          ref={canvasRef}
          className={'db-er-canvas' + (dragging ? ' is-dragging' : '')}
          onMouseDown={ev => startDrag('pan', ev, null)}
          onClick={() => {
            // 刚拖完（平移或拖节点）的那一下 click 不算"点空白"
            if (!draggedRef.current) setSelected('')
          }}
        >
          {
            loading && !layout.nodes.length
              ? (
                <div className='db-er-center'>
                  <Spin size='small' />
                </div>
                )
              : null
          }
          {
            empty
              ? <div className='db-er-center db-er-empty'>{e('dbErEmpty')}</div>
              : null
          }
          <svg className='db-er-svg' width='100%' height='100%'>
            <defs>
              <marker id='db-er-arrow' viewBox='0 0 8 8' refX='7' refY='4' markerWidth='7' markerHeight='7' orient='auto-start-reverse'>
                <path className='db-er-arrow-head' d='M0,0 L8,4 L0,8 z' />
              </marker>
              <marker id='db-er-arrow-hot' viewBox='0 0 8 8' refX='7' refY='4' markerWidth='7' markerHeight='7' orient='auto-start-reverse'>
                <path className='db-er-arrow-head db-er-arrow-hot' d='M0,0 L8,4 L0,8 z' />
              </marker>
            </defs>
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
              {
                edgeOrder.map(({ ed, hot, i }) => {
                  const dim = !!(hotEdges && !hot)
                  return (
                    <g
                      key={'e' + i}
                      className={'db-er-edge' + (hot ? ' is-hot' : '') + (dim ? ' is-dim' : '')}
                    >
                      <path
                        d={edgePath(ed)}
                        markerEnd={`url(#${hot ? 'db-er-arrow-hot' : 'db-er-arrow'})`}
                      />
                    </g>
                  )
                })
              }
              {
                nodes.map(n => {
                  const dim = !!(hotNodes && !hotNodes.has(n.id))
                  const cls = 'db-er-node' +
                    (n.id === selected ? ' is-selected' : '') +
                    (dim ? ' is-dim' : '')
                  return (
                    <g
                      key={n.id}
                      className={cls}
                      transform={`translate(${n.x} ${n.y})`}
                      onMouseDown={ev => {
                        ev.stopPropagation()
                        startDrag('node', ev, n)
                      }}
                      onMouseEnter={() => setHover(n.id)}
                      onMouseLeave={() => setHover('')}
                      onClick={ev => {
                        ev.stopPropagation()
                        if (!draggedRef.current) setSelected(n.id)
                      }}
                      onDoubleClick={() => openNode(n)}
                    >
                      <title>{`${n.schema ? n.schema + '.' : ''}${n.name}`}</title>
                      <rect width={n.w} height={n.h} rx='6' />
                      <text className='db-er-node-name' x='10' y='20'>{labelOf(n.name)}</text>
                      <text className='db-er-node-sub' x='10' y='36'>
                        {e('dbErFkCount').replace('{n}', String(n.degree))}
                      </text>
                    </g>
                  )
                })
              }
            </g>
          </svg>
        </div>
        {
          // 选中详情放在图下方：列对是"照着改 SQL"要用的东西，压在图上会挡边
          selectedNode
            ? (
              <div className='db-er-detail'>
                <span className='db-er-detail-title'>{selectedNode.name}</span>
                <span className='db-er-detail-sub'>
                  {selectedNode.schema ? selectedNode.schema + ' · ' : ''}
                  {e('dbErFkCount').replace('{n}', String(selectedNode.degree))}
                </span>
                {
                  selectedEdges.length
                    ? (
                      <ul className='db-er-detail-list'>
                        {
                          selectedEdges.map((ed, i) => (
                            <li key={i}>
                              <span className='db-er-detail-fk'>{ed.name}</span>
                              <span className='db-er-detail-col'>
                                {ed.from.name}.{ed.columns.map(c => c.from).join(', ')}
                              </span>
                              <span className='db-er-detail-sep'>→</span>
                              <span className='db-er-detail-col'>
                                {ed.to.name}({ed.columns.map(c => c.to).join(', ')})
                              </span>
                            </li>
                          ))
                        }
                      </ul>
                      )
                    : <span className='db-er-detail-sub'>{e('dbErNoFkForTable')}</span>
                }
                <Button
                  size='small'
                  icon={<FolderOpenOutlined />}
                  onClick={() => openNode(selectedNode)}
                >
                  {e('dbErOpenTable')}
                </Button>
              </div>
              )
            : null
        }
      </div>
    </Modal>
  )
}
