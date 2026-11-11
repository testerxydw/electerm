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
const STATUS_TEXT = path.resolve(__dirname, '../../client/common/mcp-status-text.js')
const CONFIG_VALIDATE = path.resolve(REPO, 'src/app/mcp/client/config-validate.js')
const SECTION_SRC = path.resolve(__dirname, '../../client/components/ai/mcp-server-config.jsx')
const AI_CONFIG_SRC = path.resolve(__dirname, '../../client/components/ai/ai-config.jsx')
const STORE_CLIENT = path.resolve(__dirname, '../../client/store/mcp-client.js')
const LOCALES_EXTRA_SRC = path.resolve(REPO, 'src/app/common/locales-extra.js')

let fv
let cv
let statusText

before(async () => {
  fv = await import(pathToFileURL(FORM_VALIDATE).href)
  statusText = await import(pathToFileURL(STATUS_TEXT).href)
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

// ---------------------------------------------------------------------------
// P0-1 状态面（实测三个真缺陷）：
//   ① server id 从未在渲染层生成 → 每次 syncConfig 重连 + 徽章永不渲染；
//   ② failed/degraded 文案缺 lastError，且没有「重试」按钮；
//   ③ i18n 缺 retry / degraded。
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_-]{3,32}$/

describe('P0-1① newServerId / newServerDraft 在渲染层就分配 id', () => {
  it('newServerId() 满足主进程 ID_PATTERN，长度 ≤ 10（别名 mcp__<id>__ 有 64 上限）', () => {
    for (let i = 0; i < 200; i++) {
      const id = fv.newServerId()
      assert.match(id, ID_PATTERN, `生成的 id 必须匹配主进程 ID_PATTERN：${id}`)
      assert.ok(id.length <= 10, `id 必须 ≤ 10 字符（实际 ${id.length}：${id}）`)
    }
  })

  it('两次调用不同（同一进程内不会撞 id）', () => {
    const a = fv.newServerId()
    const b = fv.newServerId()
    assert.notEqual(a, b)
  })

  it('newServerDraft().id 非空且合法（原来是空串，缺 id 导致每次校验重新生成）', () => {
    const d = fv.newServerDraft()
    assert.ok(d.id, 'newServerDraft 必须带 id——空 id 会让主进程每次校验现场生成新 id')
    assert.match(d.id, ID_PATTERN)
  })

  it('主进程校验器原样保留该 id（证明「不回写」缺陷已从源头绕过）', () => {
    const draft = { ...fv.newServerDraft(), name: 'fs', transport: 'stdio', command: 'node' }
    const first = cv.validateMcpServers([draft])
    const second = cv.validateMcpServers([draft])
    assert.deepEqual(first.errors, [], '带 id 的草稿必须零错误')
    assert.equal(first.servers[0].id, draft.id, '主进程必须沿用渲染层 id，不得重新生成')
    assert.equal(second.servers[0].id, draft.id, '两次校验 id 必须稳定（原来是两次不同 → 每次重连）')
  })

  it('接线检查：编辑旧配置（id 为空）时就地补 id，保存即写回 config', () => {
    const src = fs.readFileSync(SECTION_SRC, 'utf8')
    assert.ok(
      src.includes('!copyDraft.id') && src.includes('newServerId()'),
      '编辑无 id 的历史条目必须补 newServerId()，否则永远走主进程现场生成路径'
    )
  })
})

describe('P0-1② mcpStatusText 状态文案（failed/degraded 带 lastError）', () => {
  const t = k => ({ ready: 'Ready', failed: 'Failed', degraded: 'Unstable' })[k] || k

  it('ready → 「Ready (3)」（保持既有计数格式，探针与 UI 断言按它读）', () => {
    assert.equal(statusText.mcpStatusText({ state: 'ready', toolCount: 3 }, t).text, 'Ready (3)')
    assert.equal(statusText.mcpStatusText({ state: 'ready' }, t).text, 'Ready (0)')
  })

  it('failed → 含 Failed 且含 lastError', () => {
    const { text } = statusText.mcpStatusText({ state: 'failed', lastError: 'boom' }, t)
    assert.ok(text.includes('Failed'), text)
    assert.ok(text.includes('boom'), text)
  })

  it('failed 且 lastError 为空 → 恰好 Failed（不留孤零零的冒号）', () => {
    assert.equal(statusText.mcpStatusText({ state: 'failed', lastError: '' }, t).text, 'Failed')
    assert.equal(statusText.mcpStatusText({ state: 'failed' }, t).text, 'Failed')
  })

  it('degraded → 含 Unstable 与 lastError（不能再把 state 原样渲染出去）', () => {
    const { text } = statusText.mcpStatusText({ state: 'degraded', lastError: 'page 2 failed' }, t)
    assert.ok(text.includes('Unstable'), text)
    assert.ok(text.includes('page 2 failed'), text)
    assert.ok(!text.includes('degraded'), '不能退化成原始 state 字符串')
  })

  it('超长 lastError 被截断到 < 300 且以 … 结尾（防徽章撑爆一行）', () => {
    const { text } = statusText.mcpStatusText({ state: 'failed', lastError: 'x'.repeat(300) }, t)
    assert.ok(text.length < 300, `长度必须 < 300，实际 ${text.length}`)
    assert.ok(text.endsWith('…'), `必须以省略号结尾：${text}`)
  })

  it('未知状态原样回 state；无状态回空串', () => {
    assert.equal(statusText.mcpStatusText({ state: 'idle' }, t).text, 'idle')
    assert.equal(statusText.mcpStatusText(null, t).text, '')
  })
})

describe('P0-1② 接线检查（接线检查，不是行为断言）· 重试按钮与状态节点', () => {
  const sectionSrc = fs.readFileSync(SECTION_SRC, 'utf8')

  it('failed/degraded 行渲染重试按钮，且走 mcpClientRestart', () => {
    assert.ok(sectionSrc.includes('mcp-retry-btn'), '重试按钮必须带 mcp-retry-btn 类名')
    assert.ok(sectionSrc.includes('mcpClientRestart'), '重试必须调 store.mcpClientRestart(serverId)')
    assert.ok(
      sectionSrc.includes("state.state === 'failed'") && sectionSrc.includes("state.state === 'degraded'"),
      '重试按钮只在 failed/degraded 出现'
    )
    assert.ok(sectionSrc.includes('mcpClientGetTools({ force: true })'), '重试后必须 force 重拉 tools')
  })

  it('状态节点带 mcp-status 类名，文案来自 mcpStatusText', () => {
    assert.ok(sectionSrc.includes('mcp-status'), '状态节点必须带 mcp-status 类名')
    assert.ok(sectionSrc.includes('mcpStatusText'), '文案必须走纯函数 mcpStatusText')
  })

  it('重试按钮在 Edit 按钮之前', () => {
    const retryPos = sectionSrc.indexOf('mcp-retry-btn')
    const editPos = sectionSrc.indexOf('startEdit(index)')
    assert.ok(retryPos > -1 && editPos > -1, '重试与编辑按钮都必须存在')
    assert.ok(retryPos < editPos, '重试按钮必须排在 Edit 之前')
  })
})

describe('P0-1③ i18n：retry / degraded 两种语言都补齐', () => {
  it('locales-extra.js 的 en / zhCn 两节都定义 retry 与 degraded', () => {
    const src = fs.readFileSync(LOCALES_EXTRA_SRC, 'utf8')
    const count = re => (src.match(re) || []).length
    assert.ok(count(/^\s{2}retry:\s*'/gm) >= 2, `retry 必须在 en/zhCn 两节都有（实际 ${count(/^\s{2}retry:\s*'/gm)}）`)
    assert.ok(count(/^\s{2}degraded:\s*'/gm) >= 2, `degraded 必须在 en/zhCn 两节都有（实际 ${count(/^\s{2}degraded:\s*'/gm)}）`)
  })
})
