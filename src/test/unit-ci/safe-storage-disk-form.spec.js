/**
 * 行为测试：凭据「落盘形态」与「解不开时的收场」，都走真实 sqlite 层。
 *
 * 为什么另起一个文件：`safe-storage-fallback.spec.js` 里所谓「enc:v1:plain:
 * 组合前缀」是**同义反复** —— 自己拼出 `'enc:' + PLAIN_PREFIX + json` 再断言
 * `stored.startsWith('enc:' + PLAIN_PREFIX)`，无论产品代码怎么改都恒真；真正
 * 决定名字的 `sqlite.js` 只被源码正则扫了一眼。这里改成：写进真库 → 读磁盘
 * 原始字节 → 断言里面到底长什么样。
 *
 * 两个落盘判据：
 *   - 无 keyring：必须是 `enc:v1:plain:{...}`（可见的明文标记）
 *   - **不得**出现 `enc:{...}`（旧形态：带 enc 徽章的裸明文，最隐蔽的那个）
 *   - 有 keyring：必须是 `enc:v2:safe:<base64>`，且文件里搜不到明文 secret
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
const AI_PATH = path.join(REPO, 'src/app/lib/ai.js')

const SECRET = 'sk-QA-DISK-PROBE-9f3a1c'
const USER = 'qa'

// 假 electron：safeStorage 按用例替换（无 keyring / 有 keyring / 解不开）
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
  Menu: { setApplicationMenu () {}, buildFromTemplate: () => {} },
  Tray: class {},
  dialog: {}
}

const axiosTrace = { create: 0, post: 0 }
const axiosStub = {
  create () {
    axiosTrace.create++
    return { get: async () => ({ data: { data: [] } }), post: async () => ({ data: {} }) }
  },
  post: async () => { axiosTrace.post++ }
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
    if (request === 'axios') {
      return axiosStub
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

/**
 * 把 safe-storage 以「指定 safeStorage 行为」重新载入一遍。
 * 该模块的 `_ss` 缓存与「只告警一次」latch 都是模块级，必须清掉缓存重 require，
 * 否则第二个用例测的是第一个用例的缓存（那样断言就没意义了）。
 * @param {object|undefined} safeStorage
 * @returns {{safeEncrypt: Function, safeDecrypt: Function, PLAIN_PREFIX: string, SAFE_PREFIX: string}}
 */
function freshSafeStorage (safeStorage) {
  electronStub.safeStorage = safeStorage
  delete require.cache[SAFE_STORAGE_PATH]
  return require(SAFE_STORAGE_PATH)
}

/** 造一个临时数据目录并返回路径 */
function tmpDataPath (tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-${tag}-`))
  tmpDirs.push(dir)
  return dir
}

/**
 * 用给定 enc/dec 建一个真 sqlite 库，写入 userConfig，返回磁盘原始字节。
 * @param {string} tag
 * @param {{safeEncrypt: Function, safeDecrypt: Function}} ss
 * @returns {Promise<{raw: string, dbFile: string, back: object, db: object}>}
 */
async function writeUserConfigAndReadRaw (tag, ss) {
  const dataPath = tmpDataPath(tag)
  const prev = process.env.DATA_PATH
  process.env.DATA_PATH = dataPath
  delete require.cache[SQLITE_PATH]
  const { createDb } = require(SQLITE_PATH)
  const db = createDb(dataPath, USER, { enc: ss.safeEncrypt, dec: ss.safeDecrypt })
  try {
    await db.dbAction('data', 'insert', {
      _id: 'userConfig',
      apiKeyAI: SECRET,
      baseURLAI: 'https://api.deepseek.com/v1',
      modelAI: 'deepseek-chat'
    })
    const dbFile = path.join(dataPath, 'users', USER, 'electerm_data.db')
    const raw = fs.readFileSync(dbFile, 'latin1')
    const back = await db.dbAction('data', 'findOne', { _id: 'userConfig' })
    return { raw, dbFile, back, db, dataPath }
  } finally {
    if (prev === undefined) delete process.env.DATA_PATH
    else process.env.DATA_PATH = prev
  }
}

/** 恒等「加密」：只搬字节，用来模拟正常可用的 keyring */
const identityStorage = {
  encryptString: (str) => Buffer.from(str, 'utf8'),
  decryptString: (buf) => buf.toString('utf8')
}

describe('凭据落盘形态：真 sqlite 库，读磁盘原始字节', () => {
  it('无 keyring：落盘必须是 enc:v1:plain:，且不得出现旧的 enc:{ 形态', async () => {
    const ss = freshSafeStorage(undefined)
    assert.equal(ss.safeEncrypt(SECRET), 'v1:plain:' + SECRET, '前提：无 keyring 时 enc 结果带明文标记')

    const { raw } = await writeUserConfigAndReadRaw('nokeyring', ss)

    assert.ok(raw.includes('enc:v1:plain:'), '磁盘上必须出现 enc:v1:plain: 组合前缀')
    assert.ok(
      raw.includes('enc:v1:plain:{"apiKeyAI":"' + SECRET),
      '明文必须紧跟可见标记，而不是裸奔'
    )
    // 这条才是真回归靶子：旧实现产出 `enc:{"apiKeyAI":"sk-…"}` —— 带加密徽章的明文
    assert.doesNotMatch(raw, /enc:\{/, '不得出现 enc:{ 形态（带 enc 徽章的裸明文）')
  })

  it('有 keyring：落盘是 enc:v2:safe:<base64>，文件里搜不到明文 secret', async () => {
    const ss = freshSafeStorage(identityStorage)
    const enc = ss.safeEncrypt(SECRET)
    assert.equal(enc, 'v2:safe:' + Buffer.from(SECRET).toString('base64'), '前提：可用 keyring 走 v2')

    const { raw, back } = await writeUserConfigAndReadRaw('withkeyring', ss)

    assert.ok(raw.includes('enc:v2:safe:'), '磁盘上应是 enc:v2:safe:')
    assert.ok(!raw.includes(SECRET), '落盘不得出现明文 key')
    assert.ok(!raw.includes('v1:plain:'), '可用 keyring 时不该退化成明文标记')
    assert.equal(back.apiKeyAI, SECRET, '回读必须还原')
  })

  it('无 keyring 时回读仍等于原值（老用户不受影响）', async () => {
    const ss = freshSafeStorage(undefined)
    const { back } = await writeUserConfigAndReadRaw('roundtrip', ss)
    assert.equal(back.apiKeyAI, SECRET)
    assert.equal(back.modelAI, 'deepseek-chat')
    assert.equal(back.baseURLAI, 'https://api.deepseek.com/v1')
  })
})

describe('密钥解不开的收场：读不出凭据就拒绝发请求', () => {
  it('v2:safe: 密文解不开 -> 凭据视为缺失，AI 层拒绝且不发请求', async () => {
    // keyring 存在但永远解不开（换机器 / keyring 变了）
    const ss = freshSafeStorage({
      encryptString: (str) => Buffer.from(str, 'utf8'),
      decryptString: () => {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      }
    })

    const dataPath = tmpDataPath('brokendec')
    const prev = process.env.DATA_PATH
    process.env.DATA_PATH = dataPath
    delete require.cache[SQLITE_PATH]
    const { createDb } = require(SQLITE_PATH)
    const db = createDb(dataPath, USER, { enc: ss.safeEncrypt, dec: ss.safeDecrypt })

    // 手工塞一条「别处机器加密的」密文，模拟跨机器迁移
    const foreign = 'v2:safe:' + Buffer.from(
      JSON.stringify({ apiKeyAI: 'sk-OLD-MACHINE-777' })
    ).toString('base64')
    const dbFile = path.join(dataPath, 'users', USER, 'electerm_data.db')
    const { DatabaseSync } = require('node:sqlite')
    const rawDb = new DatabaseSync(dbFile)
    rawDb.prepare('INSERT OR REPLACE INTO `data` (_id, data) VALUES (?, ?)')
      .run('userConfig', 'enc:' + foreign)
    rawDb.close()

    const back = await db.dbAction('data', 'findOne', { _id: 'userConfig' })
    if (prev === undefined) delete process.env.DATA_PATH
    else process.env.DATA_PATH = prev

    // 解不开就 fail-closed：返回值里没有可用的 apiKey
    assert.ok(
      typeof back.apiKeyAI !== 'string' || back.apiKeyAI === '',
      `解不开时不得返回密文，实际拿到 ${JSON.stringify(back.apiKeyAI)}`
    )
    assert.ok(!JSON.stringify(back).includes('v2:safe:'), '不得把密文当配置值交给上层')

    // 一路走到 AI 层：必须被拒，且 axios 一次都没被建/被调
    const ai = require(AI_PATH)
    axiosTrace.create = 0
    axiosTrace.post = 0
    const res = await ai.AIlistModels('https://api.deepseek.com/v1', back.apiKeyAI, 'Authorization: Bearer', null)

    assert.equal(
      res.error,
      'AI credential unavailable: please re-enter the API key in Settings'
    )
    assert.equal(axiosTrace.create, 0, '不得建 axios 客户端')
    assert.equal(axiosTrace.post, 0, '不得发请求')
    assert.ok(!JSON.stringify(res).includes('v2:safe:'), '错误信息不得回显密文')
    assert.ok(!JSON.stringify(res).includes('sk-OLD-MACHINE'), '错误信息不得回显任何历史密钥')
  })
})
