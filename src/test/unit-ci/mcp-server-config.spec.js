/**
 * T05 · MCP servers 配置分节（M1 UI 面 / Refresh / SEC-12 徽章与默认值）。
 *
 * 三层混合（同 M12 分层原则）：
 *   - 行为层（纯函数）：徽章三态映射、新增默认 trust 来自常量（不沿用上一条）、
 *     就地校验与主进程真校验器的**逐字段一致性对照**（防两份规则漂移）。
 *   - 行为层（store）：`mcpClientRefresh` 必须带 `force:true`（后端恰好重拉
 *     tools/list，M26）——真实 mcp-client.js 动态 import 直测。
 *   - 接线层（源码契约，显式标注「接线检查，不是行为断言」）：分节组件保存/
 *     刷新/二次确认的落点、ai-config.jsx 的分节插入位置（roleAI 之前）。
 *
 * 变异自证：
 *   - 把默认 trust 改成「沿用上一条」→ 默认值断言红；
 *   - 客户端规则与 config-validate 漂移（改文案/漏规则）→ 对照矩阵红；
 *   - Refresh 按钮调 mcpClientGetTools 不带 force → force 断言红；
 *   - 删 auto 二次确认 → 接线断言红。
 */

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '../../..')
const FORM_VALIDATE = path.resolve(__dirname, '../../client/common/mcp-server-form-validate.js')
const CONFIG_VALIDATE = path.resolve(REPO, 'src/app/mcp/client/config-validate.js')
const SECTION_SRC = path.resolve(__dirname, '../../client/components/ai/mcp-server-config.jsx')
const AI_CONFIG_SRC = path.resolve(__dirname, '../../client/components/ai/ai-config.jsx')
const STORE_CLIENT = path.resolve(__dirname, '../../client/store/mcp-client.js')

let fv
let cv

before(async () => {
  fv = await import(pathToFileURL(FORM_VALIDATE).href)
  // 主进程校验器是 CJS——直接 require 作对照真源
  cv = require(CONFIG_VALIDATE)
})

describe('T04-09/T05（SEC-12）trustBadgeMeta 三态徽章', () => {
  it('readonly → 灰（default）无警示；ask → 蓝；auto → 橙 + warn', () => {
    assert.deepEqual(fv.trustBadgeMeta('readonly'), { text: 'read-only', color: 'default', warn: false })
    assert.deepEqual(fv.trustBadgeMeta('ask'), { text: 'ask every time', color: 'blue', warn: false })
    assert.deepEqual(fv.trustBadgeMeta('auto'), { text: 'auto-approve', color: 'orange', warn: true })
  })

  it('未知值 fail-safe 回落 ask 档（显示成"每次确认"比显示成放行安全）', () => {
    assert.equal(fv.trustBadgeMeta('bogus').color, 'blue')
    assert.equal(fv.trustBadgeMeta(undefined).warn, false)
  })
})

describe('T04-09（SEC-12/D1）新增 server 默认 trust 来自常量 ask，不沿用上一条', () => {
  it('上一条 trust=auto，新草稿仍是 ask（改"沿用"即红）', () => {
    const servers = [
      { id: 'a1', trust: 'auto' },
      { id: 'a2', trust: 'auto' }
    ]
    const d = fv.newServerDraft(servers)
    assert.equal(d.trust, 'ask', '默认值必须来自 DEFAULT_MCP_TRUST 常量，不得沿用上一条')
    assert.equal(fv.DEFAULT_MCP_TRUST, 'ask')
    assert.equal(d.enabled, true)
    assert.equal(d.transport, 'stdio')
  })
})

describe('T05-01（M1 UI 面）就地校验与主进程真校验器逐字段一致', () => {
  // 覆盖矩阵：每个字段至少一条非法态 + 干净态；两份规则对同字段必须给出
  // **逐字符相同**的 message（文案与 errorOf 一致由这里保证）
  const matrix = [
    { name: 'x'.repeat(129), transport: 'stdio', command: 'npx' },
    { name: 'tab\tname', transport: 'stdio', command: 'npx' },
    { name: 'quote"name', transport: 'stdio', command: 'npx' },
    { name: 'angle<name', transport: 'stdio', command: 'npx' },
    { name: 'clean name', transport: 'stdio', command: 'npx' },
    { transport: 'websocket', command: 'npx' },
    { transport: 'stdio', command: '' },
    { transport: 'stdio', command: 'a\r\nb' },
    { transport: 'stdio', command: 'x'.repeat(513) },
    { transport: 'stdio', command: 'npx', timeoutMs: 4999 },
    { transport: 'stdio', command: 'npx', timeoutMs: 300001 },
    { transport: 'stdio', command: 'npx', timeoutMs: 1.5 },
    { transport: 'stdio', command: 'npx', trust: 'yolo' },
    { transport: 'http', url: '' },
    { transport: 'http', url: 'not a url' },
    { transport: 'http', url: 'ftp://x' },
    { transport: 'http', url: 'http://127.0.0.1:3000/mcp' },
    { transport: 'stdio', command: 'npx', args: ['-y'] }
  ]
  const FIELDS = ['name', 'transport', 'timeoutMs', 'trust', 'command', 'url']

  for (const [i, draft] of matrix.entries()) {
    it(`矩阵 #${i}：${JSON.stringify(draft).slice(0, 60)}`, () => {
      const mine = fv.validateMcpServerDraft(draft).errors
      const theirs = cv.validateMcpServers([draft]).errors
        .filter(e => FIELDS.includes(e.field))
      const norm = list => list.map(e => `${e.field}: ${e.message}`).sort()
      assert.deepEqual(
        norm(mine), norm(theirs),
        '客户端就地校验与主进程 config-validate 必须逐字符一致（两份规则漂移即红）'
      )
    })
  }

  it('干净草稿零错误', () => {
    assert.deepEqual(fv.validateMcpServerDraft({
      name: 'fs', transport: 'stdio', command: 'npx', trust: 'ask', timeoutMs: 60000
    }).errors, [])
  })
})

describe('T05-02（M1/Refresh）mcpClientRefresh 必须带 force:true（真实 store 模块）', () => {
  it('调用载荷恰好 {force:true}（不带 force 的变异在此红，后端 M26 恰好重拉）', async () => {
    const mod = await import(pathToFileURL(STORE_CLIENT).href)
    const previousWindow = globalThis.window
    const payloads = []
    globalThis.window = {
      store: {},
      pre: {
        runGlobalAsync: async (name, ...args) => {
          payloads.push({ name, args })
          return { tools: [], meta: {}, servers: [], truncated: { perServer: 0, global: 0 } }
        }
      }
    }
    try {
      class Store {}
      mod.default(Store)
      const store = new Store()
      await store.mcpClientRefresh()
      const getTools = payloads.find(p => p.name === 'mcpClientGetTools')
      assert.ok(getTools, 'Refresh 必须走 mcpClientGetTools')
      assert.deepEqual(getTools.args[0], { force: true }, '载荷必须是 {force:true}——改不带 force 此处红')
    } finally {
      if (previousWindow === undefined) {
        delete globalThis.window
      } else {
        globalThis.window = previousWindow
      }
    }
  })
})

describe('接线检查（接线检查，不是行为断言）· 分节组件与 ai-config 落点', () => {
  const sectionSrc = fs.readFileSync(SECTION_SRC, 'utf8')
  const aiConfigSrc = fs.readFileSync(AI_CONFIG_SRC, 'utf8')

  it('分节保存走 setConfig + mcpClientSyncConfig（保存后对齐连接）', () => {
    assert.ok(sectionSrc.includes('mcpClientSyncConfig'), '保存后必须对齐连接')
    assert.ok(sectionSrc.includes('setConfig'), '保存必须走 store.setConfig({mcpServersAI})')
  })

  it('Refresh 按钮调 mcpClientRefresh（force 重拉语义在上面 store 面 spec 钉）', () => {
    assert.ok(sectionSrc.includes('mcpClientRefresh'))
  })

  it('切 auto 二次确认（Modal.confirm + 不再询问语义）存在', () => {
    assert.ok(sectionSrc.includes('Modal.confirm'), 'SEC-12：切 auto 必须二次确认——删除即红')
    assert.ok(
      sectionSrc.includes("value === 'auto'") && sectionSrc.includes("draft.trust !== 'auto'"),
      '只在「非 auto → auto」方向弹确认，readonly/ask 互切不打扰'
    )
  })

  it('固定提示区三句常驻（SEC-9 stdio / SEC-12-② auto / SEC-6 凭据口径），缺一即红', () => {
    assert.ok(sectionSrc.includes('mcpHintStdio'))
    assert.ok(sectionSrc.includes('mcpHintAuto'))
    assert.ok(sectionSrc.includes('mcpHintCredential'))
    assert.ok(
      sectionSrc.indexOf('mcp-fixed-hints') > -1,
      '固定提示区容器必须存在（常驻不可折叠）'
    )
  })

  it('ai-config.jsx：McpServersSection 分节在 roleAI Form.Item 之前（设计 §2.9）', () => {
    assert.ok(aiConfigSrc.includes("import McpServersSection from './mcp-server-config'"))
    const sectionPos = aiConfigSrc.indexOf('<McpServersSection />')
    const rolePos = aiConfigSrc.indexOf("name='roleAI'")
    assert.ok(sectionPos > -1, '分节必须已挂载')
    assert.ok(rolePos > sectionPos, '分节必须在 roleAI 之前（设计 §2.9 指定位置）')
  })
})
