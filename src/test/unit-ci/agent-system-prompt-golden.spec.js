/**
 * M10-③ 黄金基线：`buildAgentSystemPrompt(config)` 必须与冻结基线**逐字符**一致。
 *
 * 为什么这里要「源码抽取」而不是 `require`：
 *   `src/client/components/ai/agent.js`、`ai-guardrails.js`、`common/ai-role.js`
 *   都是 **ESM**（`import`/`export`），CJS spec 里 `require` 会直接
 *   `ERR_REQUIRE_ESM`；而且 `agent.js` 顶层还引了一堆浏览器侧模块。
 *   所以要复算这个字符串，必须把它和它的三个依赖一起从源码里抽出来，在
 *   `vm` 里跑：
 *     1. `buildAgentSystemPrompt`（agent.js）
 *     2. `appendMandatoryGuardrails`（ai-guardrails.js）
 *     3. `replyLanguageInstruction`（common/ai-role.js）
 *     4. `resolveAiLanguage`（common/ai-role.js，3 的传递依赖）
 *   少抽第 4 个就会 `ReferenceError`。下一个人不要再踩这一脚。
 *
 * 两条路径都保留（lead 2026-11-10 决定）：
 *   - **优先用导出**：一旦 `agent.js` 导出 `buildAgentSystemPrompt`，本 spec 自动
 *     改用它（见 `loadViaExport`），抽取分支只作交叉校验；
 *   - **回落到抽取**：导出被删、或导出后模块求值就抛错（例如将来有人给
 *     `agent.js` 顶层加 `const e = window.translate`），本 spec 仍能跑。
 *   删掉抽取分支，等于把「抗腐坏」换成「祈祷别人别删导出」。
 *
 * 防漂移（**这条比基线本身重要**）：
 *   本文件里的 `GOLDEN` 是**唯一**输入，spec 不读任何文档。
 *   文档 §7 附录里的 1824 / sha256 只是给人做交叉校验的注释——
 *   如果哪天有人把文档数字改坏，本 spec 不会跟着变绿。
 *
 * 基线来源：2026-11-10 冻结，基线 commit `f6e79ae6`，
 *           固定入参 `{ languageAI: 'en', roleAI: '' }`、
 *           `window.store.getLangName() === 'english'`、`window.et = {}`。
 * 基线不许「重新冻结」：不一致就必须逐字符 diff 出差异并修实现。
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const crypto = require('node:crypto')
const path = require('node:path')

// Node 解析不了 agent.js 的无扩展名 import（bundler 语义），直连 import 会
// ERR_MODULE_NOT_FOUND —— 导出路径改用沙箱夹具：闭包拷到临时目录、补 .js
// 后动态加载（代码逐字节同源，仅 specifier 不同）。见 fixtures/agent-esm-sandbox.js
const { buildAgentSandbox } = require('../fixtures/agent-esm-sandbox')

const ROOT = path.join(__dirname, '..', '..')
const AGENT = path.join(ROOT, 'client/components/ai/agent.js')
const RAILS = path.join(ROOT, 'client/components/ai/ai-guardrails.js')
const ROLE = path.join(ROOT, 'client/common/ai-role.js')

const GOLDEN_INPUT = { languageAI: 'en', roleAI: '' }
const GOLDEN_UI_LANG = 'english'
const GOLDEN_LENGTH = 1824
const GOLDEN_SHA256 =
  '19da66c3acf0e917bd7a5513aa13656e80818af0801ee488cf7d9eacb7aa2980'

// 冻结基线全文（2026-11-10）。不要「修一下」让它变绿。
const GOLDEN = `You are a helpful assistant.

You are operating inside electerm, a terminal/SSH client. You have access to tools that let you:
- Run commands in terminal tabs and read their output
- Open new terminal tabs (local or SSH)
- Manage bookmarks (create, list, open connections)
- Switch between tabs
- Transfer files via SFTP (upload, download, list, read, delete remote files)
- Inspect an open database session (current connection/database/table, table list, table structure, the result set the user is looking at), compare two tables' structure, and write SQL into its editor
- Inspect an open Redis session read-only (scan keys, read a key's value, server INFO, slow log)

Database tools are read-only by design: there is no tool that runs SQL. Use db_insert_sql to put the SQL in the editor and tell the user to run it - they confirm and execute, and write/DDL statements go through the app's danger check. Call db_get_context first; if it reports readOnly or production, say so before proposing anything that changes data. db_structure_diff only compares metadata and never generates or runs DDL; the redis_* tools only read (scan/get/INFO/slowlog) and need a Redis tab, while db_structure_diff needs a SQL tab.

When the user asks you to perform terminal operations, use the available tools.
Always explain what you are doing before executing commands.
If a command produces errors, analyze the output and try to fix the issue.
Prefer using the active terminal unless the user specifies otherwise.
For SSH connections, prefer using open_tab to connect directly, or create a bookmark with add_bookmark and open it with open_bookmark if the user wants to save the connection.
For file transfers, use the sftp_upload and sftp_download tools. The tab must be an SSH/FTP connection with SFTP initialized.

Reply in en language.`

/**
 * 从源码里按花括号配平抽一个函数，并把名字挂到沙箱全局。
 * @param {string} source 文件全文
 * @param {string} name 函数名（`function <name> (`）
 * @returns {string} 可直接 `vm.runInContext` 的片段
 */
function extractFunction (source, name) {
  const start = source.indexOf(`function ${name} (`)
  assert.notEqual(
    start,
    -1,
    `源码里找不到 \`function ${name} (\`——若该函数被重命名/改成箭头函数，` +
    '请同步本 spec 的抽取规则（M10-③ 的契约是"基线逐字符不变"，不是"函数名不变"，' +
    '但抽取要靠名字定位）'
  )
  let depth = 0
  let i = source.indexOf('{', start)
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  assert.equal(depth, 0, `抽取 \`${name}\` 时花括号未配平（源码可能被截断）`)
  return source.slice(start, i + 1)
}

/**
 * 抽取路径：四个函数 + window 桩，在 vm 里跑出 prompt。
 * @param {object} [win] window 桩
 * @param {boolean} [hasExternal] 透传 buildAgentSystemPrompt 第二参（缺省 false）
 * @returns {string}
 */
function buildViaExtraction (win, hasExternal) {
  const sandbox = { window: win, console }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  const roleSrc = fs.readFileSync(ROLE, 'utf8')
  const railsSrc = fs.readFileSync(RAILS, 'utf8')
  const agentSrc = fs.readFileSync(AGENT, 'utf8')

  for (const name of ['resolveAiLanguage', 'replyLanguageInstruction']) {
    vm.runInContext(`${extractFunction(roleSrc, name)};this.${name} = ${name};`, sandbox)
  }
  vm.runInContext(
    `${extractFunction(railsSrc, 'appendMandatoryGuardrails')};` +
    'this.appendMandatoryGuardrails = appendMandatoryGuardrails;',
    sandbox
  )
  vm.runInContext(
    `${extractFunction(agentSrc, 'buildAgentSystemPrompt')};` +
    'this.buildAgentSystemPrompt = buildAgentSystemPrompt;',
    sandbox
  )

  return sandbox.buildAgentSystemPrompt({ ...GOLDEN_INPUT }, hasExternal)
}

/**
 * 导出路径（T03-01/M17）：**源码声明了导出就必须走这条路**，任何失败显式红，
 * 不许静默回落抽取 —— 回落会掩盖「导出存在但模块求值抛错/签名被改坏」，
 * 恰好是这条路径要抓的缺陷。
 * @param {object} [win] window 桩
 * @returns {Promise<Function|null>} null = 源码还没有导出（回落抽取）
 */
async function loadViaExport (win) {
  const source = fs.readFileSync(AGENT, 'utf8')
  if (!/export function buildAgentSystemPrompt/.test(source)) {
    return null
  }
  const sandbox = buildAgentSandbox()
  const previous = globalThis.window
  globalThis.window = win
  try {
    const mod = await import(sandbox.url)
    const fn = mod && mod.buildAgentSystemPrompt
    if (typeof fn !== 'function') {
      throw new Error('agent.js 求值成功，但 buildAgentSystemPrompt 不是具名导出（导出被删或改名）')
    }
    return fn
  } catch (err) {
    throw new Error(
      '导出存在但 export 路径失败——说明模块求值抛错或签名被改坏，先修那个错：' +
      ((err && err.message) || String(err))
    )
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
    sandbox.cleanup()
  }
}

const makeWindow = () => ({
  et: {},
  store: { getLangName: () => GOLDEN_UI_LANG }
})

describe('agent system prompt golden (M10-③)', () => {
  let via = ''
  let actual = ''
  let exportMismatch = ''

  before(async () => {
    const win = makeWindow()
    actual = buildViaExtraction(win)

    const exported = await loadViaExport(makeWindow())
    if (exported) {
      via = 'export'
      let exportedPrompt = ''
      try {
        // 导出函数在调用时也要读 window.store.getLangName：调用期间同样要
        // 桩着 window（loadViaExport 只在 import 求值期间设置它）
        const callWin = makeWindow()
        const previousWindow = globalThis.window
        globalThis.window = callWin
        try {
          exportedPrompt = exported({ ...GOLDEN_INPUT })
        } finally {
          if (previousWindow === undefined) delete globalThis.window
          else globalThis.window = previousWindow
        }
      } catch (err) {
        exportMismatch = `导出版抛错：${err && err.message}`
      }
      if (!exportMismatch && exportedPrompt !== actual) {
        exportMismatch =
          '导出版与源码抽取版的输出不一致——说明导出包的不是同一个函数（或包了一层改了入参）'
      }
    } else {
      via = 'extraction'
    }
  })

  after(() => {
    // 不把 window 桩留给同进程的其它 spec
    delete globalThis.window
  })

  it('基线与冻结值逐字符一致（1824 字符）', () => {
    assert.equal(
      actual.length,
      GOLDEN_LENGTH,
      `长度从 ${GOLDEN_LENGTH} 变成 ${actual.length}（路径=${via}）。` +
      '基线不许重新冻结：请逐字符 diff 出哪句变了'
    )
    // 先自己算一次首个差异位置：`assert.equal` 的 diff 只给行级上下文，
    // 1824 字符里改一个空格时看不出到底哪一位变了。
    const max = Math.max(actual.length, GOLDEN.length)
    let firstDiff = -1
    for (let i = 0; i < max; i++) {
      if (actual[i] !== GOLDEN[i]) {
        firstDiff = i
        break
      }
    }
    if (firstDiff !== -1) {
      const from = Math.max(0, firstDiff - 30)
      assert.fail(
        `system prompt 与冻结基线不一致（路径=${via}）\n` +
        `首个差异位置：第 ${firstDiff} 个字符（0 基）\n` +
        `  冻结基线：${JSON.stringify(GOLDEN.slice(from, firstDiff + 30))}\n` +
        `  当前实现：${JSON.stringify(actual.slice(from, firstDiff + 30))}\n` +
        `长度：基线 ${GOLDEN.length} / 当前 ${actual.length}\n` +
        '若差异是"看起来更清楚"的改写，也必须先评审再改基线，不要直接改这段常量'
      )
    }
    assert.equal(actual, GOLDEN, `system prompt 与冻结基线不一致（路径=${via}）`)
  })

  it('sha256 与冻结值一致', () => {
    const sha = crypto.createHash('sha256').update(actual, 'utf8').digest('hex')
    assert.equal(sha, GOLDEN_SHA256, `sha256=${sha}（路径=${via}）`)
  })

  it('导出存在时，导出版与抽取版输出相同（防"包一层改行为"）', () => {
    assert.ok(
      via === 'export' || via === 'extraction',
      `取值路径未确定（via=${JSON.stringify(via)}）——说明 before() 没跑或两条路都不可用`
    )
    assert.equal(exportMismatch, '', exportMismatch)
  })

  it('空 roleAI 不会在开头留分号、languageAI 决定末尾那句', () => {
    const win = makeWindow()
    const custom = buildViaExtraction(win)
    assert.doesNotMatch(custom.slice(0, 5), /^;/, 'roleAI 为空时不得留下前导分号')
    assert.match(custom, /Reply in en language\.$/, 'languageAI=en 时末句必须是 `Reply in en language.`')
    assert.ok(!/Reply in {2,}language/.test(custom), '语言缺失时不得出现空档（历史 bug 形态）')
  })

  it('路径自证（M17/T03-01）：export function buildAgentSystemPrompt 必须可用（via=export）', () => {
    // 本 spec 源码文本命中 /export function buildAgentSystemPrompt/ —— 具名导出
    // 是设计 `:502` 的硬要求，因此 via 无条件必须是 export：
    // - 导出被删/改回私有 → via='extraction' → 这里红（变异：把导出改回私有）；
    // - 导出存在但模块求值抛错 → before() 直接抛「先修那个错」；
    // 不存在任何一种「导出坏了但本 spec 仍绿」的组合。
    assert.equal(
      via,
      'export',
      'buildAgentSystemPrompt 必须以具名导出可用（导出存在但 spec 走了抽取 = ' +
      '模块求值抛错/签名被改坏，先修那个错，不许静默回落抽取）'
    )
  })

  it('缺省参数与显式 false 逐字节相同（M18/T03-02 增补）', () => {
    const win = makeWindow()
    const implicit = buildViaExtraction(win)
    const explicit = buildViaExtraction(win, false)
    assert.equal(
      implicit,
      explicit,
      'hasExternal 缺省值必须等效 false，否则「不传参的老调用」与「显式 false 的新调用』分叉'
    )
  })
})
