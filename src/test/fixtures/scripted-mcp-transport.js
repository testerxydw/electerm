/**
 * 进程内脚本化 MCP transport——可复用测试夹具。
 *
 * 用途：`McpSession` / `McpClientManager` 的**完整链路**测试（握手 → 注册表 →
 * 工具集 → 调用）不必每次都拉子进程或开端口。它实现 `start/send/close/killNow`
 * 四个 transport 契约方法，并在内部用一份**独立**的最小 JSON-RPC 分发应答，
 * 因此它同时充当「另一种实现」，可以和真 server 互相印证。
 *
 * 能力：
 *   tools          工具表 [{ name, description, inputSchema, annotations, handler }]
 *   hangMethods    这些方法永不回包（超时用例）
 *   startError     start() 直接抛错（连接失败用例）
 *   protocolVersion initialize 回的版本
 *   nextCursorLoop true 时 `tools/list` **永远**返回 `nextCursor`，永不终止。
 *                  用途：分页如果不是「自然结束」而是「服务端无限给游标」，
 *                  客户端没有上限就会一直请求下去。自然分页的假 server 抓不到
 *                  这种 bug（测试只会绿），所以必须有这个模式；判据是
 *                  `tools/list` 的请求次数落在客户端声明的上限内。
 *
 * `received` 记录所有收到的报文，测试用它断言「参数确实到了 server 一侧」，
 * 也用来数 `tools/list` 的往返次数。
 */

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05']

class ScriptedTransport {
  /**
   * @param {{tools?: Array, hangMethods?: string[], startError?: Error|null,
   *   protocolVersion?: string, nextCursorLoop?: boolean}} [opts]
   */
  constructor ({
    tools = [],
    hangMethods = [],
    startError = null,
    protocolVersion = PROTOCOL_VERSIONS[0],
    nextCursorLoop = false
  } = {}) {
    this.tools = Array.isArray(tools) ? tools : []
    this.hangMethods = new Set(hangMethods)
    this.startError = startError
    this.protocolVersion = protocolVersion
    this.nextCursorLoop = nextCursorLoop
    this.received = []
    this.onMessage = null
    this.onClose = null
    this.onProtocolError = null
    this.closed = false
    this.started = false
  }

  /** @returns {Promise<object>} */
  async start () {
    if (this.startError) {
      throw this.startError
    }
    this.started = true
    return { transport: 'scripted' }
  }

  /**
   * @param {object} msg
   */
  send (msg) {
    if (this.closed) {
      throw new Error('scripted transport is closed')
    }
    // 与另两个夹具同一规则：不合形状的入站消息必须当场炸出来，不能静默吞。
    // 静默吞会让「客户端发错帧」表现成「服务端不回包」→ 用例超时 → 被误报成
    // 产品缺陷（2026-11-10 实证过一次）。
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' ||
      (msg.method !== undefined && typeof msg.method !== 'string')) {
      throw new Error('scripted transport: bad inbound shape: ' + JSON.stringify(msg))
    }
    this.received.push(msg)
    const hasId = msg.id !== undefined && msg.id !== null
    if (!hasId || this.hangMethods.has(msg.method)) {
      return
    }
    const reply = this.respond(msg)
    if (!reply) {
      return
    }
    setImmediate(() => {
      if (this.onMessage) {
        this.onMessage(reply)
      }
    })
  }

  /**
   * @param {object} msg
   * @returns {object|null}
   */
  respond (msg) {
    const params = msg.params || {}
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: this.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'scripted', version: '1.0.0' }
        }
      }
    }
    if (msg.method === 'tools/list') {
      const result = {
        tools: this.tools.map(tool => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          annotations: tool.annotations || {}
        }))
      }
      if (this.nextCursorLoop) {
        // 永不终止：客户端必须有页码/条数上限，否则这里就是死循环
        result.nextCursor = `cursor-${this.received.length}`
      }
      return { jsonrpc: '2.0', id: msg.id, result }
    }
    if (msg.method === 'tools/call') {
      const tool = this.tools.find(item => item.name === params.name)
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: `Tool not found: ${params.name}` }
        }
      }
      const args = params.arguments || {}
      const result = typeof tool.handler === 'function'
        ? tool.handler(args)
        : { content: [{ type: 'text', text: JSON.stringify(args) }] }
      return { jsonrpc: '2.0', id: msg.id, result }
    }
    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    }
  }

  /**
   * 最近一次 tools/call 的 arguments（断言「参数真的到了 server」）。
   * @returns {object|null}
   */
  lastCallArguments () {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const msg = this.received[i]
      if (msg.method === 'tools/call') {
        return (msg.params && msg.params.arguments) || {}
      }
    }
    return null
  }

  /**
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async close (reason = 'closed') {
    if (this.closed) {
      return
    }
    this.fireClose({ code: 0, signal: null, reason })
  }

  /**
   * kill 语义：上层同样必须收到关闭通知，否则 manager 的 pending 请求会
   * 永远挂着（真实 SIGKILL 会触发子进程 exit → 产品 onClose 照常响；夹具
   * 模拟必须等价，否则「in-flight promise 应在 1s 内 settle」对正确实现
   * 也会报假红）。与 close() 共用同一出口，避免两处漂移。
   */
  killNow () {
    if (this.closed) {
      return
    }
    this.fireClose({ code: null, signal: 'SIGKILL', reason: 'killNow' })
  }

  /**
   * @private
   * @param {{code: number|null, signal: string|null, reason: string}} info
   */
  fireClose (info) {
    this.closed = true
    if (this.onClose) {
      this.onClose(info)
    }
  }
}

module.exports = {
  ScriptedTransport,
  PROTOCOL_VERSIONS
}
