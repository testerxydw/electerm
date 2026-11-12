/**
 * db-import openFile 修复 · 子进程上下文简单功能用例（纯 Node，不依赖 Electron/CDP）
 *
 * 背景（2026-11-12 实机 /opt/electerm 炸点）：
 *   db-importer 运行在 db-client fork 子进程（纯 node），旧版 openFile 里
 *   require('electron') 开 dialog —— 打包 asar 无 electron npm 包，必炸。
 *   修复后 dialog 上移主进程（db-client-remote 特判 openFile），子进程只收
 *   filePath 走 preview；数据目录解析统一 DATA_PATH → env.appPath →
 *   app-props(仅主进程) → tmp 三级兜底链。
 *
 * 本文件模拟「打包子进程」上下文：把 require('electron') 打成直接抛错
 * （等价于 asar 里没有该模块），然后跑真实源码 —— 任何被测路径只要
 * 碰了 electron 就会炸出 Cannot find module 'electron'，用例即红。
 *
 * 源码契约断言（文件不得 require electron 等）见 db-importer.spec.js；
 * 实机 CDP 全链路（真 MySQL）见 self-test/db-import-cdp-probe.js。
 */
process.env.NODE_ENV = 'development'

const { describe, test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

// ---------- electron 打桩：stub 模式供模块加载；throw 模式模拟打包子进程 ----------
let electronMode = 'stub' // 'stub' | 'throw'
const electronStub = { app: { getPath: () => '/tmp', isPackaged: false }, dialog: {} }
const electronLogStub = {
  transports: { console: {}, file: {} },
  info: () => {},
  error: () => {},
  warn: () => {},
  log: () => {},
  debug: () => {}
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron' && electronMode === 'throw') {
    throw new Error("Cannot find module 'electron'")
  }
  if (request === 'electron') {
    return electronStub
  }
  if (request === 'electron-log') {
    return electronLogStub
  }
  return originalLoad.call(this, request, parent, isMain)
}

const { dbImportOp } = require('../../app/lib/db-importer')
const { getDataDir } = require('../../app/widgets/paths')
const { getLogDir, setLogDir } = require('../../app/widgets/instance-log')
const { TerminalOutputArchive } = require('../../app/server/terminal-output-archive')

// 环境变量卫生：进程内共享 env，组内改、组后还原，避免污染其他 spec
const savedEnv = {}
function withEnv (patch, fn) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k]
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
      delete savedEnv[k]
    }
  }
}

after(() => {
  electronMode = 'stub'
  assert.ok(Object.keys(savedEnv).length === 0, 'env 未还原：' + Object.keys(savedEnv).join(','))
})

// 测试素材：真实临时 csv
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-openfile-spec-'))
const csvPath = path.join(tmp, 'people.csv')
fs.writeFileSync(csvPath, 'name,age\nfoo,1\nbar,2\n')

describe('A. 子进程上下文：openFile 全路径不碰 electron（打包 asar 模拟）', () => {
  test('openFile 未选文件 → {filePath:null}，不抛 Cannot find module electron', () => {
    electronMode = 'throw'
    const r = dbImportOp('openFile', {})
    assert.deepStrictEqual(r, { filePath: null })
  })

  test('openFile 带 filePath → 子进程纯 node 直出预览（主进程转发后的目标口径）', () => {
    electronMode = 'throw'
    const r = dbImportOp('openFile', { filePath: csvPath })
    assert.strictEqual(r.filePath, csvPath)
    assert.strictEqual(r.format, 'csv')
    assert.strictEqual(r.kind, 'rows')
    assert.deepStrictEqual(r.columns, ['name', 'age'])
    assert.strictEqual(r.sampleRows.length, 2)
    assert.strictEqual(typeof r.totalBytes, 'number')
  })

  test('preview op（主进程选中文件后的转发 op）与 openFile 带路径等价', () => {
    electronMode = 'throw'
    const r = dbImportOp('preview', { filePath: csvPath })
    assert.deepStrictEqual(r.columns, ['name', 'age'])
    assert.strictEqual(r.sampleRows.length, 2)
  })

  test('文件不存在 → 抛业务错误（ENOENT），不是 electron 模块错误', () => {
    electronMode = 'throw'
    assert.throws(
      () => dbImportOp('openFile', { filePath: path.join(tmp, 'nope.csv') }),
      e => /ENOENT/.test(e.message) && !/electron/.test(e.message)
    )
  })

  test('未知 action 报错口径不变', () => {
    assert.throws(() => dbImportOp('bogus', {}), /unknown dbImportOp action/)
  })
})

describe('B. 子进程数据目录：无 electron 也能算对，不许静默落 tmp', () => {
  test('widgets/paths: DATA_PATH 优先（数据目录本身，不再拼 electerm）', () => {
    electronMode = 'throw'
    withEnv({ DATA_PATH: '/tmp/dp-spec-a', appPath: undefined }, () => {
      assert.strictEqual(getDataDir(), '/tmp/dp-spec-a')
    })
  })

  test('widgets/paths: 无 DATA_PATH 有 appPath → appPath/electerm（fork 子进程关键口径）', () => {
    electronMode = 'throw'
    withEnv({ DATA_PATH: undefined, appPath: '/opt/some-path' }, () => {
      assert.strictEqual(getDataDir(), path.join('/opt/some-path', 'electerm'))
    })
  })

  test('widgets/paths: 两者皆无且 electron 抛错 → tmp 兜底不崩（等价无 appPath 的裸进程）', () => {
    electronMode = 'throw'
    withEnv({ DATA_PATH: undefined, appPath: undefined }, () => {
      assert.strictEqual(getDataDir(), path.join(os.tmpdir(), 'electerm'))
    })
  })

  test('terminal-output-archive: DATA_PATH 下不再拼第二层 electerm（旧双层目录回归锁）', () => {
    electronMode = 'throw'
    withEnv({ DATA_PATH: '/tmp/dp-spec-b', appPath: undefined }, () => {
      const a = new TerminalOutputArchive({ pid: 'spec' })
      assert.strictEqual(a.dir, path.join('/tmp/dp-spec-b', 'lossless_output'))
      assert.ok(!a.dir.includes(path.join('electerm', 'electerm')), '不许出现 electerm/electerm')
    })
  })

  test('terminal-output-archive: 仅 appPath → appPath/electerm/lossless_output', () => {
    electronMode = 'throw'
    withEnv({ DATA_PATH: undefined, appPath: '/opt/some-path' }, () => {
      const a = new TerminalOutputArchive({ pid: 'spec' })
      assert.strictEqual(a.dir, path.join('/opt/some-path', 'electerm', 'lossless_output'))
    })
  })

  test('terminal-output-archive: 显式 dir 参数永远最高优先（既有调用方不受影响）', () => {
    const a = new TerminalOutputArchive({ pid: 'spec', dir: '/tmp/explicit-dir' })
    assert.strictEqual(a.dir, '/tmp/explicit-dir')
  })

  test('instance-log: DATA_PATH → DATA_PATH/widget_logs（缓存经 setLogDir 重置后生效）', () => {
    electronMode = 'throw'
    withEnv({ DATA_PATH: '/tmp/dp-spec-c', appPath: undefined }, () => {
      const prev = getLogDir()
      setLogDir('')
      try {
        assert.strictEqual(getLogDir(), path.join('/tmp/dp-spec-c', 'widget_logs'))
      } finally {
        setLogDir(prev)
      }
    })
  })

  test('instance-log: 仅 appPath → appPath/electerm/widget_logs', () => {
    electronMode = 'throw'
    withEnv({ DATA_PATH: undefined, appPath: '/opt/some-path' }, () => {
      const prev = getLogDir()
      setLogDir('')
      try {
        assert.strictEqual(getLogDir(), path.join('/opt/some-path', 'electerm', 'widget_logs'))
      } finally {
        setLogDir(prev)
      }
    })
  })
})
