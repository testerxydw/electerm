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
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Segmented, Table, Alert, Spin, Button, Collapse, Empty } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import message from '../common/message'
import { downloadText } from '../../common/db-csv'

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
  sql = ''
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [view, setView] = useState('tree')
  const svgRef = useRef(null)

  // 打开时拉取执行计划：sql/database/tabId 变化即重查
  useEffect(() => {
    if (!open || !sql) {
      return
    }
    setLoading(true)
    setError('')
    setData(null)
    setView('tree')
    window.pre.runGlobalAsync('dbClientOp', tabId, 'explainQuery', {
      sql,
      database: database || '',
      schema: schema || ''
    })
      .then(res => {
        setData(res && res.root ? res : null)
        setLoading(false)
      })
      .catch(err => {
        setError(err && err.message ? err.message : String(err))
        setLoading(false)
      })
  }, [open, sql, tabId, database, schema])

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

  // 导出：SVG 直接序列化下载；PNG 经 Image → canvas 二倍分辨率转制
  const exportGraph = (kind) => {
    const svg = svgRef.current
    if (!svg || !graph) {
      return
    }
    const xml = new window.XMLSerializer().serializeToString(svg)
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
        className='db-explain-tree'
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
      </div>
      {error ? <Alert type='error' showIcon message={error} /> : null}
      <Spin spinning={loading}>
        <div className='db-explain-body'>
          {renderBody()}
        </div>
      </Spin>
    </Modal>
  )
}
