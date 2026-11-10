/**
 * 假 MCP server（stdio，换行分隔 JSON-RPC 2.0）——可复用测试夹具。
 *
 * 为什么不用现成的 SDK：本仓 `src/app/mcp/server/mcp.js` 只有工具注册表，没有
 * stdio 分帧实现；而「客户端和本仓 HTTP server 互相自洽」并不能证明对端是
 * spec-conforming（双方可能共同误解）。所以这里用最朴素的方式独立实现分帧
 * （一行一条 JSON），只借用 `McpServer` 作为工具表的容器（lead 指定复用）。
 *
 * 用法（客户端会以子进程方式拉起）：
 *   node src/test/fixtures/fake-mcp-server.js --stdio
 *
 * **teardown 约束（务必遵守）**：这是子进程，`kill()` 返回不等于它已经死了。
 * 收尾必须轮询 `process.kill(pid, 0)` 直到抛 `ESRCH`（最多 2s），用下面导出的
 * `waitForProcessExit(pid)` 即可。QA 实测过一次「kill() 完就当死了」，结果整套
 * 测试挂起约 2 分钟 —— 因为管道还开着，node:test 一直等句柄。
 *
 * 开关（**`--tools=N` 是精确总数，不是"N 个额外的"**）：
 *   --tools=N        注册**恰好 N 个**工具，N ≥ 1，其中第 1 个恒为 `echo`。
 *                    例：`--tools=3` → `echo` + `tool_1` + `tool_2`（共 3 个）。
 *                    默认（不带该开关）只注册 `echo`。
 *                    曾经的语义是"echo + huge + N 个 tool_i"，于是 `--tools=3`
 *                    实际吐 5 个 —— flag 在说谎，按字面写 3 的断言全误红，而让
 *                    断言改写成 `N+2` 等于把谎言固化成契约。所以改成精确计数，
 *                    `huge` 拆成独立开关。
 *   --huge           额外注册 `huge`（schema 超过 8 KiB，触发降级），**不计入**
 *                    `--tools=N` 的 N。查降级路径时必须显式带上。
 *   --hang           收到 tools/call 后不回包（超时用例）
 *   --bad-version    initialize 回一个双方都不支持的版本号（协商失败用例）
 *   --page-size=N    tools/list 分页返回（每页 N 个，带 nextCursor）
 *   --hang-on-page=N 第 N 页（**1 起算**）的 tools/list 永不回包，用于验证
 *                    「分页预算耗尽 / 第 2 页失败不得丢掉第 1 页已拿到的工具」
 *   --exit-on-init   收到 initialize 后立即退出（连接中断用例）
 *
 * 入站报文自校验（**不要改回"非 JSON 就 continue"**）：形状不合规的帧一律
 * stderr 打原文 + `exit(9)`。原因是 `continue` 会让「客户端发错帧」表现成
 * 「服务端不回包」→ 用例走超时断言 → 报告成产品缺陷，排查方向直接被带偏。
 * 空行属于合法 framing（换行分帧的填充），仍然跳过。
 *
 * 工具：
 *   echo  { text: string, ...任意多余键 }  → 原样回显收到的 arguments
 *   huge  { filter: <200 条长 enum> }       → schema 超过 8 KiB，触发降级
 */

const readline = require('node:readline')
const { McpServer } = require('../../app/mcp/server/mcp')

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05']
const BAD_PROTOCOL_VERSION = '2020-01-01'
const ENUM_ENTRIES = 200
const ENUM_ENTRY_LENGTH = 80

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseFlags (argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (!match) {
      continue
    }
    flags[match[1]] = match[2] === undefined ? true : match[2]
  }
  return flags
}

/**
 * 一个「大到必定被裁掉」的 enum：192 条 80 字符的字符串稳定超过 8 KiB 预算。
 * 用 enum 而不是「很多字段」，是因为宽 schema 会被 propsPerLevel 收紧到能过关，
 * 只有 enum 这类不随层级收缩的内容能真正把字节数顶穿。
 * @returns {object}
 */
function buildHugeSchema () {
  const values = []
  for (let i = 0; i < ENUM_ENTRIES; i++) {
    const suffix = String(i).padStart(3, '0')
    values.push(`value-${suffix}-` + 'x'.repeat(ENUM_ENTRY_LENGTH - 10))
  }
  return {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description: 'which slice to return',
        enum: values
      }
    },
    required: ['filter']
  }
}

/**
 * @param {object} flags
 * @returns {McpServer}
 */
function buildServer (flags) {
  const server = new McpServer({ name: 'fake-mcp-server', version: '1.0.0' })
  server.registerTool('echo', {
    description: 'echo back the arguments it received',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'text to echo' }
      },
      required: ['text']
    }
  }, (args) => ({
    content: [{ type: 'text', text: JSON.stringify(args) }]
  }))
  if (flags.huge) {
    // 独立开关、不计入 --tools=N 的 N（见文件头注释的语义说明）
    server.registerTool('huge', {
      description: 'a tool whose schema cannot fit the provider budget',
      inputSchema: buildHugeSchema()
    }, (args) => ({
      content: [{ type: 'text', text: `huge:${JSON.stringify(args)}` }]
    }))
  }
  // --tools=N = 恰好 N 个（含恒在的 echo）；不带该开关时只有 echo
  const total = Number(flags.tools === undefined ? 1 : flags.tools)
  if (!Number.isInteger(total) || total < 1) {
    process.stderr.write(`fake-mcp-server: --tools must be an integer >= 1, got: ${flags.tools}\n`)
    process.exit(2)
  }
  for (let i = 1; i < total; i++) {
    const name = `tool_${i}`
    server.registerTool(name, {
      description: `extra echo tool ${i}`,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } }
      }
    }, (args) => ({
      content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }]
    }))
  }
  return server
}

/**
 * @param {object} msg
 */
function writeMessage (msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/**
 * @param {McpServer} server
 * @param {object} flags
 * @param {object} msg
 * @returns {object|null} the response, or null when no response is due
 */
function handle (server, flags, msg) {
  const { id, method } = msg
  const params = msg.params || {}
  if (method === 'initialize') {
    if (flags['exit-on-init']) {
      process.exit(0)
    }
    const requested = params.protocolVersion
    const supported = flags['bad-version']
      ? [BAD_PROTOCOL_VERSION]
      : SUPPORTED_PROTOCOL_VERSIONS
    const protocolVersion = supported.includes(requested) ? requested : supported[0]
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake-mcp-server', version: '1.0.0' }
      }
    }
  }
  if (method === 'notifications/initialized') {
    return null
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} }
  }
  if (method === 'tools/list') {
    const names = Array.from(server.tools.keys())
    const pageSize = Number(flags['page-size'] || 0)
    if (pageSize > 0) {
      const offset = Number(params.cursor || 0)
      const hangOnPage = Number(flags['hang-on-page'] || 0)
      // 第 N 页（1 起算）永不回包：客户端必须靠自己的分页预算收敛，且不得把
      // 前面几页已拿到的工具丢掉（partial-result 判据的对端）
      if (hangOnPage > 0 && Math.floor(offset / pageSize) + 1 === hangOnPage) {
        return null
      }
      const page = names.slice(offset, offset + pageSize)
      const nextOffset = offset + page.length
      const result = {
        tools: page.map(name => describeTool(server, name))
      }
      if (nextOffset < names.length) {
        result.nextCursor = String(nextOffset)
      }
      return { jsonrpc: '2.0', id, result }
    }
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: names.map(name => describeTool(server, name)) }
    }
  }
  if (method === 'tools/call') {
    if (flags.hang) {
      // 故意不回包：客户端必须靠自己超时收敛
      return null
    }
    const name = params.name
    const tool = server.tools.get(name)
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Tool not found: ${name}` }
      }
    }
    return Promise.resolve(tool.handler(params.arguments || {})).then(result => ({
      jsonrpc: '2.0',
      id,
      result
    }))
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  }
}

/**
 * @param {McpServer} server
 * @param {string} name
 * @returns {object}
 */
function describeTool (server, name) {
  const tool = server.tools.get(name)
  return {
    name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }
}

async function main () {
  const flags = parseFlags(process.argv.slice(2))
  if (!flags.stdio) {
    process.stderr.write('fake-mcp-server: pass --stdio\n')
    process.exit(2)
  }
  const server = buildServer(flags)
  const rl = readline.createInterface({ input: process.stdin })
  for await (const line of rl) {
    if (!line.trim()) {
      continue
    }
    let msg
    try {
      msg = JSON.parse(line)
    } catch (_) {
      // 静默忽略会让「客户端发错帧」表现成「服务端不回包」→ 用例超时 →
      // 被误报成产品缺陷（2026-11-10 实证过一次）。宁可把夹具打死。
      process.stderr.write('fake-mcp-server: non-JSON input: ' + JSON.stringify(line) + '\n')
      process.exit(9)
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' ||
      (msg.method !== undefined && typeof msg.method !== 'string')) {
      process.stderr.write('fake-mcp-server: bad inbound shape: ' + JSON.stringify(line) + '\n')
      process.exit(9)
    }
    let response
    try {
      response = await handle(server, flags, msg)
    } catch (err) {
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: err.message }
      }
    }
    if (response) {
      writeMessage(response)
    }
  }
}

/**
 * 进程是否还活着（`kill(pid, 0)` 只是在探活，不发信号）。
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH'
  }
}

/**
 * 轮询等待子进程真的消失，给 teardown 用。
 * @param {number} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true = 已退出
 */
async function waitForProcessExit (pid, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return !isProcessAlive(pid)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fake-mcp-server: fatal ${err && err.message}\n`)
    process.exit(1)
  })
}

module.exports = {
  parseFlags,
  buildServer,
  buildHugeSchema,
  handle,
  isProcessAlive,
  waitForProcessExit,
  SUPPORTED_PROTOCOL_VERSIONS,
  BAD_PROTOCOL_VERSION
}
