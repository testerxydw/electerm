/**
 * 行为测试：凭据缺失时 AI 层必须 fail-closed，而不是把空 key 发出去。
 *
 * 为什么另起一个文件（`safe-storage-fallback.spec.js` 已有同名 describe）：
 * 那边的 3 条 AI 断言全是**源码正则**，把 `assertCredential` 的守卫条件改成
 * `if (true)`（等于彻底关掉守卫）它们依然 3/3 通过 —— 零杀伤力。这里改成真调
 * `AIlistModels` / `AIchatWithTools` / `AIchat`，并用 Module._load 注入 axios 桩，
 * 直接断言「axios 到底有没有被建/被调」。
 *
 * `src/app/lib/ai.js` 在纯 node 进程里加载不了（间接 require `electron` 与
 * `src/app/package.json`，后者只存在于打包产物），所以必须注入两个桩：
 *   - `electron`：app.getName/getPath 等，运行时常量模块要用
 *   - `../package.json`（parent 为 runtime-constants.js）：{ name, version }
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')

const REPO = path.resolve(__dirname, '../../..')
const AI_PATH = path.join(REPO, 'src/app/lib/ai.js')

const MISSING = 'AI credential unavailable: please re-enter the API key in Settings'

// ---------- electron / axios 桩 ----------

const electronStub = {
  app: {
    getName: () => 'electerm',
    getPath: () => require('node:os').tmpdir(),
    getVersion: () => '0.0.0',
    isPackaged: false
  },
  ipcMain: { handle () {}, on () {}, removeHandler () {} },
  safeStorage: {},
  shell: { openExternal () {} },
  nativeTheme: { shouldUseDarkColors: false, on () {} },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: { setApplicationMenu () {}, buildFromTemplate: () => {} },
  Tray: class {},
  dialog: {}
}

// 每次 axios.create / post 都记一笔，用来证明「拒绝发生在建连之前」
const axiosTrace = { create: [], post: 0, get: 0 }

const axiosStub = {
  create (cfg) {
    axiosTrace.create.push(cfg)
    return {
      get: async () => { axiosTrace.get++; return { data: { data: [{ id: 'model-a' }] } } },
      post: async () => {
        axiosTrace.post++
        return { data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }
      }
    }
  },
  post: async () => { axiosTrace.post++ }
}

let originalLoad

before(() => {
  originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return electronStub
    }
    // runtime-constants.js 在打包产物里 require('../package.json')，src 下没有
    if (
      request === '../package.json' &&
      parent &&
      /runtime-constants\.js$/.test(parent.filename)
    ) {
      return { name: 'electerm', version: '0.0.0' }
    }
    if (request === 'axios') {
      return axiosStub
    }
    return originalLoad.call(this, request, parent, isMain)
  }
})

after(() => {
  Module._load = originalLoad
})

/** 载入真实 ai.js（只载一次，守卫是纯函数无状态） */
function loadAI () {
  return require(AI_PATH)
}

/**
 * 调一次 AIlistModels 并记录 axios 用量。
 * @param {string} baseURL
 * @param {string} apiKey
 * @returns {Promise<{result: object, creates: number}>}
 */
async function listModels (baseURL, apiKey) {
  axiosTrace.create.length = 0
  axiosTrace.post = 0
  axiosTrace.get = 0
  const result = await loadAI().AIlistModels(baseURL, apiKey, 'Authorization: Bearer', null)
  return { result, creates: axiosTrace.create.length, posts: axiosTrace.post }
}

/** 一次请求都没发出去 */
function assertNoRequest (trace) {
  assert.equal(trace.creates, 0, '不得创建 axios 客户端')
  assert.equal(trace.posts, 0, '不得发出 POST')
  assert.equal(axiosTrace.get, 0, '不得发出 GET')
}

// ---------- loopback 免鉴权（Ollama / LM Studio / local vLLM） ----------

const LOOPBACK_URLS = [
  'http://localhost:11434/v1',
  'http://127.0.0.1:1234/v1',
  'http://0.0.0.0:8080/v1',
  'http://[::1]:8080/v1'
]

describe('AI 凭据 fail-closed：空 key 不得发请求', () => {
  it('loopback 网关空 key 放行：四类环回地址都要能连本地 provider', async () => {
    for (const url of LOOPBACK_URLS) {
      const trace = await listModels(url, '')
      assert.equal(trace.result.error, undefined, `${url} 不该被拦：${JSON.stringify(trace.result)}`)
      assert.deepEqual(trace.result.models, ['model-a'], url)
      assert.equal(trace.creates, 1, `${url} 应该建了 1 个客户端`)
    }
  })

  it('远端 provider 空 key / 纯空白 key 一律拒绝，且请求一个都不发', async () => {
    for (const key of ['', '   ', '\t\n', undefined, null, 0]) {
      const trace = await listModels('https://api.deepseek.com/v1', key)
      assert.equal(trace.result.error, MISSING, `key=${JSON.stringify(key)}`)
      assertNoRequest(trace)
    }
  })

  it('伪装环回必须拒绝：127.0.0.1.evil.com / localhost.evil.com / userinfo 绕过', async () => {
    // 肉眼看着像环回、实际 host 不是的几种写法，全部要落到「远端」分支：
    //   - 后缀伪装：'.' 不在白名单里
    //   - userinfo 伪装：`127.0.0.1:8080@` 只是 userinfo，host 是 @ 之后那段
    //   - 未加方括号的 IPv6：new URL() 直接抛 ERR_INVALID_URL → fail-closed
    for (const url of [
      'http://127.0.0.1.evil.com/v1',
      'http://localhost.evil.com/v1',
      'http://127.0.0.1:8080@evil.com/v1',
      'http://[::1]:8080@evil.com/v1',
      'http://::1/v1'
    ]) {
      const trace = await listModels(url, '')
      assert.equal(trace.result.error, MISSING, `${url} 必须被拒`)
      assertNoRequest(trace)
    }
  })

  it('对照组：远端 provider + 正常 key 放行', async () => {
    const trace = await listModels('https://api.deepseek.com/v1', 'sk-live-abc')
    assert.equal(trace.result.error, undefined)
    assert.equal(trace.creates, 1)
    const cfg = axiosTrace.create[0]
    assert.equal(cfg.baseURL, 'https://api.deepseek.com/v1')
    // key 只以 header 形式出现，拼成 "Bearer <key>"
    assert.equal(cfg.headers.Authorization, 'Bearer sk-live-abc')
  })

  it('拒绝文案点名「去设置里重填」，且不回显任何凭据', async () => {
    const trace = await listModels('https://api.deepseek.com/v1', '')
    const text = JSON.stringify(trace.result)
    assert.match(trace.result.error, /re-enter the API key in Settings/)
    assert.doesNotMatch(text, /Bearer/)
    assert.doesNotMatch(text, /v1:plain:|v2:safe:/)
  })

  it('AIchatWithTools / AIchat 两条入口同样 fail-closed', async () => {
    const ai = loadAI()

    axiosTrace.create.length = 0
    const tools = await ai.AIchatWithTools(
      [{ role: 'user', content: 'hi' }],
      'deepseek-chat',
      'https://api.deepseek.com/v1',
      '/chat/completions',
      ''
    )
    assert.equal(tools.error, MISSING)
    assert.equal(axiosTrace.create.length, 0, 'AIchatWithTools 不得建客户端')

    axiosTrace.create.length = 0
    axiosTrace.post = 0
    const chat = await ai.AIchat(
      'hi',
      'deepseek-chat',
      'you are helpful',
      'https://api.deepseek.com/v1',
      '/chat/completions',
      ''
    )
    assert.equal(chat.error, MISSING)
    assert.equal(axiosTrace.create.length, 0, 'AIchat 不得建客户端')
    assert.equal(axiosTrace.post, 0, 'AIchat 不得发 POST')
  })
})

// ---------- 两处 loopback 正则必须一致 ----------

/**
 * 从源码里抠出一个具名函数/箭头常量，执行后返回该函数。
 * 目的是把「复制了两份的正则」放在同一份语料上比对，防漂移。
 * @param {string} src
 * @param {string} name
 * @returns {Function}
 */
function extractPredicate (src, name) {
  const fnStart = src.indexOf(`function ${name} (`)
  let code
  if (fnStart !== -1) {
    const braceStart = src.indexOf('{', fnStart)
    let depth = 0
    let end = -1
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    assert.ok(end > braceStart, `${name} 花括号没闭合`)
    code = src.slice(fnStart, end + 1)
  } else {
    // 箭头常量形态：const isLoopbackURL = (baseURL) => ... 直到以 .test(...) 收尾
    const arrowStart = src.indexOf(`const ${name} = `)
    assert.ok(arrowStart !== -1, `源码里找不到 ${name}`)
    const tail = src.indexOf('.test(String(baseURL', arrowStart)
    assert.ok(tail > arrowStart, `${name} 箭头体没找到 .test 收尾`)
    const close = src.indexOf('\n', tail)
    code = src.slice(arrowStart, close === -1 ? src.length : close)
    code = code.replace(/const\s+\w+\s*=\s*/, '')
    code = `const fn = ${code}\nmodule.exports = fn`
  }
  if (fnStart !== -1) {
    code += `\nmodule.exports = ${name}`
  }
  // URL 解析搬进沙箱：判定从「字符串前缀正则」改成「new URL().hostname 白名单」后，
  // vm 的新上下文里没有 Node 的 URL 全局（vm.runInNewContext('typeof URL') === 'undefined'），
  // 不注入就会 ReferenceError。
  const sandbox = { module: { exports: {} }, exports: {}, URL }
  vm.runInNewContext(code, sandbox)
  return sandbox.module.exports
}

describe('loopback 判定两处实现必须一致（防正则漂移）', () => {
  const corpus = [
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://0.0.0.0:8080/v1',
    'http://[::1]:8080/v1',
    'http://LOCALHOST:1/v1',
    'http://127.0.0.1',
    'http://127.0.0.1/v1',
    'https://api.deepseek.com/v1',
    'http://127.0.0.1.evil.com/v1',
    'http://localhost.evil.com/v1',
    // userinfo 绕过：host 是 @ 之后那段，必须是远端
    'http://127.0.0.1:8080@evil.com/v1',
    'http://[::1]:8080@evil.com/v1',
    // 合法 userinfo 指向环回：host 仍是 127.0.0.1，两侧都必须判环回
    'http://evil.com@127.0.0.1/v1',
    // 未加方括号的 IPv6：new URL() 抛错 → 非环回
    'http://::1/v1',
    'http://127.0.0.10/v1',
    'http://0.0.0.1/v1',
    '',
    null,
    undefined
  ]

  it('app 侧 isLoopbackURL 与 client 侧 isLoopbackBaseURL 判定完全一致', () => {
    const appPred = extractPredicate(
      fs.readFileSync(AI_PATH, 'utf8'), 'isLoopbackURL'
    )
    const clientPred = extractPredicate(
      fs.readFileSync(path.join(REPO, 'src/client/components/ai/ai-config.jsx'), 'utf8'),
      'isLoopbackBaseURL'
    )
    const diff = corpus.filter(u => appPred(u) !== clientPred(u))
    assert.deepEqual(diff, [], `两处判定不一致的输入：${JSON.stringify(diff)}`)
  })

  it('默认 baseURLAI 不是环回，配置缺失时「重填 key」提示才有机会出现', () => {
    // ai-config.jsx 的 credentialUnavailable = configured && !apiKeyAI &&
    // !isLoopbackBaseURL(baseURLAI)。userConfig 整行解不开时读出来是 {}，
    // getConfig 用默认值兜底，所以默认值必须是远端地址，提示才会亮。
    const defs = require(path.join(REPO, 'src/app/common/config-default'))
    const pred = extractPredicate(fs.readFileSync(AI_PATH, 'utf8'), 'isLoopbackURL')
    assert.equal(pred(defs.baseURLAI), false, `默认 baseURLAI=${defs.baseURLAI} 竟是环回`)
    assert.ok(defs.modelAI, '默认 modelAI 必须非空，否则 configured 判不出 true')
  })
})
