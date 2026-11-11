/**
 * T04 · M11（T04-07）：`mcpServersAI` 凭据落盘口径 · 走真实 sqlite 层。
 *
 * 手法复用 safe-storage-disk-form.spec.js（写进真库 → 读磁盘原始字节 →
 * 断言里面到底长什么样），把 payload 换成含凭据的 `mcpServersAI`：
 * `[{transport:'stdio', command:'…', apiKey:'sk-…', headers:{Authorization:'Bearer …'}}]`。
 *
 * 落盘判据（与 P0-2 同口径，default-setting.js:87 —— userConfig 整行走
 * enc:/safeEncrypt）：
 *   - 无 keyring：必须是 `enc:v1:plain:{…}`（可见的明文标记）
 *   - **不得**出现 `enc:{…}`（旧形态：带 enc 徽章的裸明文，最隐蔽的那个）
 *   - 有 keyring：必须是 `enc:v2:safe:<base64>`，且文件里搜不到明文 secret
 *
 * 变异自证：把落盘改成无 enc 前缀的裸 JSON（明文）→ 无 keyring 用例的
 * `enc:v1:plain:` 断言红 + `enc:{`/裸 JSON 断言红；把 keyring 分支改成
 * 明文回退 → 有 keyring 用例「搜不到明文 secret」断言红。
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const REPO = path.resolve(__dirname, '../../..')
const SAFE_STORAGE_PATH = path.join(REPO, 'src/app/lib/safe-storage.js')
const SQLITE_PATH = path.join(REPO, 'src/app/lib/sqlite.js')

const MCP_TOKEN = 'sk-QA-MCP-TOKEN-7c1d9e'
const MCP_AUTH = 'Bearer qa-mcp-auth-4f2b8a'

const SERVERS = [
  {
    id: 'srv1234',
    name: 'qa-server',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    trust: 'ask',
    enabled: true,
    apiKey: MCP_TOKEN,
    headers: { Authorization: MCP_AUTH }
  }
]

const electronStub = {
  app: {
    getName: () => 'electerm',
    getPath: () => os.tmpdir(),
    getVersion: () => '0.0.0',
    isPackaged: false
  },
  ipcMain: { handle () {}, on () {}, removeHandler () {} },
  safeStorage: undefined,
  shell: { openExternal () {} },
  nativeTheme: { shouldUseDarkColors: false, on () {} },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: { setApplicationMenu () {}, buildFromTemplate () {} },
  Tray: class {},
  dialog: {}
}

let originalLoad
const tmpDirs = []

before(() => {
  originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return electronStub
    }
    if (
      request === '../package.json' &&
      parent &&
      /runtime-constants\.js$/.test(parent.filename)
    ) {
      return { name: 'electerm', version: '0.0.0' }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
})

after(() => {
  Module._load = originalLoad
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function freshSafeStorage (safeStorage) {
  electronStub.safeStorage = safeStorage
  delete require.cache[SAFE_STORAGE_PATH]
  return require(SAFE_STORAGE_PATH)
}

function tmpDataPath (tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-mcp-disk-${tag}-`))
  tmpDirs.push(dir)
  return dir
}

/**
 * 用给定 enc/dec 建真 sqlite 库，写入含 mcpServersAI 的 userConfig，
 * 返回磁盘原始字节与回读对象。
 */
async function writeMcpConfigAndReadRaw (tag, ss) {
  const dataPath = tmpDataPath(tag)
  const prevDataPath = process.env.DATA_PATH
  process.env.DATA_PATH = dataPath
  delete require.cache[SQLITE_PATH]
  const { createDb } = require(SQLITE_PATH)
  const db = createDb(dataPath, 'qa', { enc: ss.safeEncrypt, dec: ss.safeDecrypt })
  try {
    await db.dbAction('data', 'insert', {
      _id: 'userConfig',
      mcpServersAI: SERVERS
    })
    const dbFile = path.join(dataPath, 'users', 'qa', 'electerm_data.db')
    const raw = fs.readFileSync(dbFile, 'latin1')
    const back = await db.dbAction('data', 'findOne', { _id: 'userConfig' })
    return { raw, back, db }
  } finally {
    if (prevDataPath === undefined) {
      delete process.env.DATA_PATH
    } else {
      process.env.DATA_PATH = prevDataPath
    }
    if (db && typeof db.close === 'function') {
      try { db.close() } catch (_) { /* 只读收尾 */ }
    }
  }
}

describe('T04-07（M11）mcpServersAI 凭据落盘口径', () => {
  it('无 keyring：enc:v1:plain: 可见明文标记，禁 enc:{ 裸明文形态', async () => {
    const ss = freshSafeStorage(undefined)
    const { raw, back } = await writeMcpConfigAndReadRaw('nokeyring', ss)
    assert.ok(
      raw.includes('enc:' + ss.PLAIN_PREFIX),
      '无 keyring 落盘必须是 enc:v1:plain: 形态'
    )
    assert.ok(
      !raw.includes('enc:{'),
      '禁止 enc:{ 旧形态（带 enc 徽章的裸明文，最隐蔽）'
    )
    // 解密回读：server 配置完好（不是"整份丢弃"）
    const servers = back && back.mcpServersAI
    assert.ok(Array.isArray(servers) && servers.length === 1)
    assert.equal(servers[0].apiKey, MCP_TOKEN, '回读必须还原 apiKey')
    assert.equal(servers[0].headers.Authorization, MCP_AUTH)
    assert.equal(servers[0].trust, 'ask')
  })

  it('有 keyring：enc:v2:safe: 形态，磁盘原始字节搜不到明文凭据', async () => {
    // 对称 stub：encryptString 输出 base64('enc-'+plain)，decryptString 反解
    const ss2 = freshSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from('enc-' + plain).toString('base64'),
      // safe-storage 已把 enc:v2:safe: 前缀剥掉并 base64 解码成 Buffer，
      // 这里的 buf 直接就是 'enc-' + 明文 的字节
      decryptString: (buf) => {
        const dec = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
        return dec.startsWith('enc-') ? dec.slice(4) : ''
      }
    })
    const { raw, back } = await writeMcpConfigAndReadRaw('keyring', ss2)
    assert.ok(
      raw.includes('enc:' + ss2.SAFE_PREFIX),
      '有 keyring 落盘必须是 enc:v2:safe: 形态'
    )
    assert.ok(
      !raw.includes(MCP_TOKEN) && !raw.includes(MCP_AUTH),
      '磁盘原始字节不得出现明文 token / Authorization'
    )
    const servers = back && back.mcpServersAI
    assert.equal(servers && servers[0] && servers[0].apiKey, MCP_TOKEN, '回读必须还原')
  })
})
