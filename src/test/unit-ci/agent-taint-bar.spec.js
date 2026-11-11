/**
 * T04 · taint 提示条渲染断言（M15-②，SEC-13-①）· 组件级真渲染。
 *
 * 判据要求：tainted 时面板渲染提示条，textContent **同时含 server 名与
 * 工具名**（固定 srv-a / tool-x 渲染后断言），**不许**只断言源码里有那段
 * JSX（A4 型假绿，验证台账 §2.4 的教训）。本 spec 用 react-dom/server 对
 * **真实组件源码**做静态渲染——渲染的是磁盘上的字节，不是 spec 里的复制体。
 *
 * 加载方式：组件源码是纯 JS（createElement），剥掉 react import 后在
 * Function 里求值出真组件函数，再走 react-dom/server 渲染。组件本体若被
 * 改坏（删掉 server/tool span、改掉警示文案）这里必红。
 */

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const SRC = path.resolve(__dirname, '../../client/components/ai/agent-taint-bar.jsx')

let AgentTaintBar

before(() => {
  const src = fs.readFileSync(SRC, 'utf8')
    // 剥掉 ESM import（node 直渲染链拿不到裸 specifier），其余逐字节保留
    .replace(/import\s*\{[^}]*\}\s*from\s*'react'\s*;?/, 'const createElement = __react.createElement;')
    .replace(/export\s+default\s+function/, 'function')
  // vm 求值（同 db-agent-tools.spec.js 的源码抽取先例）：组件源码里任何
  // JSX 语法混入都会在这里语法报错（本组件约定用 createElement，
  // 见其文件头注释）
  AgentTaintBar = vm.runInNewContext(src + '\nAgentTaintBar', {
    __react: React
  })
})

describe('T04-08（M15-②）AgentTaintBar 真渲染断言', () => {
  it('tainted：textContent 同时含 server 名与工具名（srv-a / tool-x）', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentTaintBar, { server: 'srv-a', tool: 'tool-x' })
    )
    assert.ok(html.includes('agent-taint-bar'), '提示条容器必须渲染')
    assert.ok(html.includes('srv-a'), `渲染输出必须含 server 名：${html}`)
    assert.ok(html.includes('tool-x'), `渲染输出必须含工具名：${html}`)
    // SEC-13 文案语义：外部结果 + 内置写操作逐次确认，两段语义缺一即红
    assert.ok(
      html.includes('read results from an external MCP server'),
      '文案必须说明"已读取外部工具结果"'
    )
    assert.ok(
      html.includes('built-in write tools') && html.includes('confirmed one by one'),
      '文案必须说明"内置写操作将逐次确认"'
    )
    assert.equal(html.includes('data-tainted="true"'), true)
  })

  it('只有 server 名（无 tool）时也不缺信息、不崩', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentTaintBar, { server: 'srv-a', tool: '' })
    )
    assert.ok(html.includes('srv-a'))
    assert.ok(html.includes('agent-taint-server'))
  })

  it('缺省（无 server/tool）仍渲染警示文案（防御：字段丢失不得吞掉整条提示）', () => {
    const html = renderToStaticMarkup(React.createElement(AgentTaintBar, {}))
    assert.ok(html.includes('read results from an external MCP server'))
    assert.ok(html.includes('built-in write tools'))
  })
})
