/**
 * Taint notice bar（SEC-13-①，T04）。当前 run 读过外部 MCP 工具结果期间，
 * AI 面板常驻显示：本次对话已读取外部工具结果（server / 工具名）；内置写
 * 操作（SFTP 上传/下载/删除、SQL 写入编辑器）将逐次确认。
 *
 * 纯展示组件：props 进、无 store 读取——是否渲染由 ai-chat.jsx 按
 * `props.agentTainted` 条件挂载（run 结束 store 归 false 后消失）。
 *
 * **写成 createElement 而非 JSX 语法**（内容仍是合法 JSX 超集）：单测要在
 * node 里对它做 react-dom/server **真渲染**断言（M15-② 明令禁止只断言源码
 * 里有那段 JSX——那是 A4 型假绿），而仓库测试链没有 JSX 转译器（agent 沙箱
 * 只做 specifier 补全）。一个叶子展示组件换 createElement 换来真渲染可测性，
 * 是划算的交易。
 */
import { createElement } from 'react'

const barStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  margin: '0 0 4px',
  borderRadius: 4,
  background: 'rgba(255, 153, 0, 0.12)',
  border: '1px solid rgba(255, 153, 0, 0.45)',
  color: '#b26a00',
  fontSize: 12,
  lineHeight: '18px'
}

export default function AgentTaintBar ({ server = '', tool = '' }) {
  const hasSource = !!(server || tool)
  return createElement('div', {
    className: 'agent-taint-bar',
    style: barStyle,
    role: 'alert',
    'data-tainted': 'true'
  },
  createElement('span', null, '⚠'),
  createElement('span', null,
    'This conversation has read results from an external MCP server',
    hasSource ? ' (' : '',
    server ? createElement('span', { className: 'agent-taint-server' }, server) : null,
    server && tool ? ' / ' : '',
    tool ? createElement('span', { className: 'agent-taint-tool' }, tool) : null,
    hasSource ? '); ' : '; ',
    'built-in write tools (SFTP upload/download/delete, SQL to editor) will be confirmed one by one.'
  )
  )
}
