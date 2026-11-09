/**
 * EXPLAIN 执行计划弹窗（D 批，设计 §12.1）
 *
 * 数据契约（后端 explainQuery）：{ dialect, root, raw }
 * - root：统一节点树 { nodeType, table, rows, filtered, key, extra, cost, children }
 * - raw：服务端原始 JSON（折叠查看）
 *
 * 三视图：树（ant Table 树形数据）/ 图（自绘 SVG 纵向树，零第三方图库）/ JSON（默认折叠）。
 * 图视图支持导出 SVG / PNG（渲染层 Blob + canvas 转制，不经主进程）。
 * 后端拒绝 ANALYZE 的错误信息原样展示——安全语义不做前端转述。
 * N7 受控实测：显式「实测执行计划」开关（默认关）。开着时真跑语句：
 * 能力位 explainAnalyze（sqlite 无）才显示开关；只读连接禁用；每次实测前过
 * confirmSqlRisk 二次确认，取消则开关弹回关。MySQL 实测返回 TREE 文本（root=null），
 * PG 返回带 actualRows 的计划树（事务内跑完即回滚，见后端 explainQuery）。
 *
 * 统一滚动通道（非虚拟分支）：本弹层树视图是 antd 树形表格（defaultExpandAllRows），
 * 走不了 DbGridTable —— antd 6.5.1 的 virtual 会切到 @rc-component/table 的
 * genVirtualTable（antd/lib/table/InternalTable.js:430），而虚拟表格①要求每列有数值
 * width（VirtualTable/BodyGrid.js 用 width||0 累加，本表 Extra 列无 width）、
 * ②展开层级缩进明确未实现（VirtualTable/VirtualCell.js:51 的
 * `TODO: support expandableRowOffset`）、③ scroll.x 必须是 number 而 DbGridTable 写死
 * 'max-content'（虚拟表格会把非 number 的 x 退化成 1）。且 .db-explain-body 是
 * 树/图/JSON 三视图共用的 max-height:60vh 滚动容器，改成 wrap 定高会连累另两个视图。
 * 因此这里只挂 db-session.styl 的共用 class .db-sticky-thead（非虚拟分支唯一真源），
 * 由滚动容器自身承担滚动、表头 sticky 吸顶；组件层不写任何 scroll.y / virtual /
 * position:sticky，不与 DbGridTable 形成第三套分叉。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Modal, Segmented, Switch, Table, Tooltip, Spin, Button, Collapse, Empty } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import message from '../common/message'
import { downloadText } from '../../common/db-csv'
import { capabilityOf } from '../../common/sql-dialects'

const e = window.translate

// 图布局常量：节点尺寸 + 层间/兄弟间距
const NODE_W = 168
const NODE_H = 46
const VGAP = 58
const HGAP = 18

// 纯函数：统一节点树 → { nodes, edges, width, height }。
// 叶子按序水平排布，父节点 x = 首末子节点中线；返回边从父底边中点指向子顶边中点
function layoutPlan (root) {
  const nodes = []
  const edges = []
  let leafCursor = 0
  let maxDepth = 0
  const walk = (n, depth) => {
    const kids = Array.isArray(n.children) ? n.children : []
    const y = depth * (NODE_H + VGAP)
    let cx
    if (!kids.length) {
      cx = leafCursor * (NODE_W + HGAP) + NODE_W / 2
      leafCursor++
      nodes.push({ ...n, x: cx - NODE_W / 2, y })
    } else {
      const centers = []
      for (const k of kids) {
        centers.push(walk(k, depth + 1))
      }
      cx = (centers[0] + centers[centers.length - 1]) / 2
      nodes.push({ ...n, x: cx - NODE_W / 2, y })
      for (const childCx of centers) {
        edges.push({ x1: cx, y1: y + NODE_H, x2: childCx, y2: y + NODE_H + VGAP })
      }
    }
    maxDepth = Math.max(maxDepth, depth)
    return cx
  }
  walk(root, 0)
  const width = Math.max(leafCursor * (NODE_W + HGAP) - HGAP, NODE_W)
  const height = (maxDepth + 1) * NODE_H + maxDepth * VGAP
  return { nodes, edges, width, height }
}

// 纯函数：统一节点树 → ant Table 树形数据（children 展开展示）
function toTableRows (node, seq) {
  const kids = Array.isArray(node.children) ? node.children : []
  seq.n++
  return {
    __key: 'n' + seq.n,
    nodeType: node.nodeType,
    table: node.table,
    rows: node.rows,
    actualRows: node.actualRows,
    filtered: node.filtered,
    key: node.key,
    extra: node.extra,
    cost: node.cost,
    children: kids.length ? kids.map(c => toTableRows(c, seq)) : undefined
  }
}

const fmtCell = v => (v === null || v === undefined ? '-' : String(v))

export default function DbExplainDialog ({
  open = false,
  onClose,
  tabId,
  database = '',
  schema = '',
  sql = '',
  dbType = '',
  readOnly = false,
  confirmSqlRisk = null
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [view, setView] = useState('tree')
  // N7：实测开关，默认关（验收项）。能力位 false（sqlite）不渲染开关。
  const [analyze, setAnalyze] = useState(false)
  const analyzeAllowed = capabilityOf(dbType, 'explainAnalyze')
  const svgRef = useRef(null)

  // 打开时拉取执行计划：sql/database/tabId 变化即重查；analyze 切换也重查。
  // 实测前过 confirmSqlRisk 二次确认（N7 要点②），取消则开关弹回关、保留上一轮预估数据
  useEffect(() => {
    if (!open || !sql) {
      return undefined
    }
    let alive = true
    const run = async () => {
      if (analyze && confirmSqlRisk) {
        let ok = false
        try {
          ok = await confirmSqlRisk(sql, database)
        } catch (err) {
          ok = false
        }
        if (!alive) {
          return
        }
        if (!ok) {
          setAnalyze(false)
          return
        }
      }
      setLoading(true)
      setError('')
      setData(null)
      setView('tree')
      try {
        const res = await window.pre.runGlobalAsync('dbClientOp', tabId, 'explainQuery', {
          sql,
          database: database || '',
          schema: schema || '',
          analyze
        })
        if (!alive) {
          return
        }
        setData(res && (res.root || res.analyze) ? res : null)
        setLoading(false)
      } catch (err) {
        if (!alive) {
          return
        }
        setError(err && err.message ? err.message : String(err))
        setLoading(false)
      }
    }
    run()
    return () => {
      alive = false
    }
  }, [open, sql, tabId, database, schema, analyze, confirmSqlRisk])

  const treeRows = useMemo(() => {
    if (!data || !data.root) {
      return []
    }
    return [toTableRows(data.root, { n: 0 })]
  }, [data])

  const graph = useMemo(() => {
    if (!data || !data.root) {
      return null
    }
    return layoutPlan(data.root)
  }, [data])

  // 导出前把外部 CSS 解析成内联属性：XMLSerializer 不带走样式表，
  // 节点/连线/文本只挂 class（fill/stroke 定义在 styl 里且是 var(--x)），
  // 直接序列化的 SVG/PNG 会是黑块。clone 后按计算样式逐元素内联 ——
  // 计算值来自当前主题，深浅主题导出都天然跟随（QA BUG-3）
  const inlineSvgStyles = (srcSvg) => {
    const clone = srcSvg.cloneNode(true)
    const srcEls = srcSvg.querySelectorAll('*')
    const dstEls = clone.querySelectorAll('*')
    const props = ['fill', 'stroke', 'stroke-width', 'font-size', 'font-weight', 'font-family']
    for (let i = 0; i < srcEls.length; i++) {
      const cs = window.getComputedStyle(srcEls[i])
      for (const p of props) {
        const v = cs.getPropertyValue(p)
        if (v) {
          dstEls[i].setAttribute(p, v)
        }
      }
    }
    return clone
  }

  // 导出：SVG 直接序列化下载；PNG 经 Image → canvas 二倍分辨率转制
  const exportGraph = (kind) => {
    const svg = svgRef.current
    if (!svg || !graph) {
      return
    }
    const xml = new window.XMLSerializer().serializeToString(inlineSvgStyles(svg))
    const name = 'db-explain-' + Date.now()
    if (kind === 'svg') {
      downloadText(name + '.svg', 'image/svg+xml;charset=utf-8', xml)
      return
    }
    const svgUrl = URL.createObjectURL(
      new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
    )
    const img = new window.Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = graph.width * 2
        canvas.height = graph.height * 2
        const ctx = canvas.getContext('2d')
        ctx.scale(2, 2)
        // 底色跟主题（透明画布在深色主题下导出会变成黑底看不清）
        const bg = window.getComputedStyle(document.body).backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)') {
          ctx.fillStyle = bg
          ctx.fillRect(0, 0, graph.width, graph.height)
        }
        ctx.drawImage(img, 0, 0, graph.width, graph.height)
        canvas.toBlob(png => {
          if (!png) {
            message.error(e('dbExplainExportFailed'))
            return
          }
          const pngUrl = URL.createObjectURL(png)
          const a = document.createElement('a')
          a.href = pngUrl
          a.download = name + '.png'
          a.click()
          setTimeout(() => URL.revokeObjectURL(pngUrl), 1000)
        }, 'image/png')
      } catch (err) {
        message.error(e('dbExplainExportFailed'))
      } finally {
        URL.revokeObjectURL(svgUrl)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl)
      message.error(e('dbExplainExportFailed'))
    }
    img.src = svgUrl
  }

  const treeColumns = [
    {
      title: e('dbExplainNode'),
      dataIndex: 'nodeType',
      key: 'nodeType',
      width: 150,
      render: v => <span className='db-explain-type'>{fmtCell(v)}</span>
    },
    { title: e('dbExplainTable'), dataIndex: 'table', key: 'table', width: 130, render: fmtCell },
    { title: e('dbExplainRows'), dataIndex: 'rows', key: 'rows', width: 90, render: fmtCell },
    // N7：实际行数只在实测（ANALYZE）输出里有，预估计划恒为 '-'
    { title: e('dbExplainActualRows'), dataIndex: 'actualRows', key: 'actualRows', width: 90, render: fmtCell },
    { title: e('dbExplainFiltered'), dataIndex: 'filtered', key: 'filtered', width: 90, render: fmtCell },
    { title: e('dbExplainKeyCol'), dataIndex: 'key', key: 'key', width: 120, ellipsis: true, render: fmtCell },
    {
      title: e('dbExplainExtra'),
      dataIndex: 'extra',
      key: 'extra',
      ellipsis: true,
      render: v => (v === null || v === undefined ? '-' : <span className='db-explain-extra'>{v}</span>)
    },
    { title: e('dbExplainCost'), dataIndex: 'cost', key: 'cost', width: 80, render: fmtCell }
  ]

  const renderBody = () => {
    if (error || loading) {
      return null
    }
    if (!data || !data.root) {
      // MySQL 实测返回 TREE 文本（无 root 树），直接原文展示
      if (data && data.analyze && typeof data.raw === 'string' && data.raw) {
        return <pre className='db-explain-json-pre'>{data.raw}</pre>
      }
      return <Empty description={e('dbExplainNoPlan')} />
    }
    if (view === 'graph' && graph) {
      return (
        <svg
          ref={svgRef}
          className='db-explain-svg'
          xmlns='http://www.w3.org/2000/svg'
          width={graph.width}
          height={graph.height}
          viewBox={'0 0 ' + graph.width + ' ' + graph.height}
        >
          {graph.edges.map((ed, i) => (
            <line
              key={'e' + i}
              className='db-explain-edge'
              x1={ed.x1}
              y1={ed.y1}
              x2={ed.x2}
              y2={ed.y2}
            />
          ))}
          {graph.nodes.map((n, i) => (
            <g key={'n' + i} transform={'translate(' + n.x + ', ' + n.y + ')'}>
              <rect width={NODE_W} height={NODE_H} rx='8' className='db-explain-node' />
              <text x='10' y='19' className='db-explain-node-title'>
                {String(n.nodeType) + (n.table ? ' · ' + n.table : '')}
              </text>
              <text x='10' y='35' className='db-explain-node-sub'>
                {(n.rows === null || n.rows === undefined ? 'rows -' : 'rows ' + n.rows) +
                  (n.cost === null || n.cost === undefined ? '' : ' · cost ' + n.cost)}
              </text>
            </g>
          ))}
        </svg>
      )
    }
    if (view === 'json') {
      return (
        <Collapse
          className='db-explain-json'
          items={[
            {
              key: 'raw',
              label: e('dbExplainRawJson'),
              children: (
                <pre className='db-explain-json-pre'>
                  {JSON.stringify(data.raw, null, 2)}
                </pre>
              )
            }
          ]}
        />
      )
    }
    return (
      <Table
        size='small'
        className='db-explain-tree db-sticky-thead'
        columns={treeColumns}
        dataSource={treeRows}
        rowKey='__key'
        pagination={false}
        defaultExpandAllRows
      />
    )
  }

  return (
    <Modal
      open={open}
      className='db-explain-modal'
      width={860}
      title={e('dbExplainTitle')}
      footer={null}
      maskClosable
      onCancel={onClose}
      destroyOnClose
    >
      <div className='db-explain-toolbar'>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { label: e('dbExplainViewTree'), value: 'tree' },
            { label: e('dbExplainViewGraph'), value: 'graph' },
            { label: e('dbExplainViewJson'), value: 'json' }
          ]}
        />
        {
          // 导出只对图视图有意义（导的就是 SVG 画布）
          view === 'graph'
            ? (
              <>
                <Button
                  size='small'
                  icon={<DownloadOutlined />}
                  onClick={() => exportGraph('svg')}
                >
                  {e('dbExplainExportSvg')}
                </Button>
                <Button
                  size='small'
                  icon={<DownloadOutlined />}
                  onClick={() => exportGraph('png')}
                >
                  {e('dbExplainExportPng')}
                </Button>
              </>
              )
            : null
        }
        {
          // N7：实测开关，能力位 explainAnalyze 才有（sqlite 没有就不渲染）；
          // 只读连接禁用（后端也会拒，这里是 UI 先降级），说明放 Tooltip
          analyzeAllowed
            ? (
              <Tooltip title={readOnly ? e('dbExplainAnalyzeReadonly') : e('dbExplainAnalyzeTip')}>
                <span className='db-explain-analyze'>
                  <Switch
                    size='small'
                    checked={analyze}
                    disabled={readOnly}
                    onChange={setAnalyze}
                  />
                  <span>{e('dbExplainAnalyze')}</span>
                </span>
              </Tooltip>
              )
            : null
        }
      </div>
      {
        // 实测成功：明确告诉用户这条语句真的执行过了（N7 验收「估算 vs 实际」的语义提示）
        !error && !loading && data && data.analyze
          ? <Alert type='warning' showIcon message={e('dbExplainAnalyzeWarn')} className='mg1b' />
          : null
      }
      {error ? <Alert type='error' showIcon message={error} /> : null}
      <Spin spinning={loading}>
        <div className='db-explain-body'>
          {renderBody()}
        </div>
      </Spin>
    </Modal>
  )
}
