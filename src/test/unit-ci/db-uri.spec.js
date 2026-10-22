// A5 快速连接 URI 解析：纯函数矩阵（设计 §3.2 验收）
// ESM 源码 vm 加载：constants 模块 stub 提供 dbDefaultPortMap
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = path.join(__dirname, '../../client/common/db-uri.js')

function loadFns () {
  let src = fs.readFileSync(SRC, 'utf8')
  src = src.replace(/^import .*$/gm, '')
  src = src.replace(/^export /gm, '')
  const sandbox = {
    dbDefaultPortMap: { mysql: 3306, postgres: 5432, redis: 6379 },
    // vm context 不继承宿主全局，URL/decodeURIComponent 显式传入
    URL,
    decodeURIComponent
  }
  vm.createContext(sandbox)
  return vm.runInContext(`(function () { ${src}; return { parseDbUri } })()`, sandbox)
}

describe('db-uri parseDbUri', () => {
  const { parseDbUri } = loadFns()

  test('mysql 完整 URI', () => {
    const r = parseDbUri('mysql://root:secret@10.0.0.3:13306/appdb')
    assert.deepEqual(
      { ...r },
      { dbType: 'mysql', dbHost: '10.0.0.3', dbPort: 13306, dbUser: 'root', dbPassword: 'secret', dbName: 'appdb' }
    )
  })

  test('postgres 与 postgresql scheme 同映射', () => {
    for (const s of ['postgres', 'postgresql']) {
      const r = parseDbUri(`${s}://u@pg.local/db`)
      assert.equal(r.dbType, 'postgres')
      assert.equal(r.dbHost, 'pg.local')
      assert.equal(r.dbPort, 5432, 'default port')
      assert.equal(r.dbUser, 'u')
      assert.equal(r.dbPassword, '')
      assert.equal(r.dbName, 'db')
    }
  })

  test('mysql 缺省端口/无密码/无库名', () => {
    const r = parseDbUri('mysql://root@h1/')
    assert.equal(r.dbPort, 3306)
    assert.equal(r.dbPassword, '')
    assert.equal(r.dbName, '')
  })

  test('redis path 序号 → dbIndex，缺省 0', () => {
    const r1 = parseDbUri('redis://:pass@r.local:6380/2')
    assert.equal(r1.dbType, 'redis')
    assert.equal(r1.dbIndex, 2)
    assert.equal(r1.dbUser, '')
    assert.equal(r1.dbPassword, 'pass')
    const r2 = parseDbUri('redis://r.local')
    assert.equal(r2.dbIndex, 0)
    assert.equal(r2.dbPort, 6379)
  })

  test('特殊字符密码 percent-encoding round-trip', () => {
    const r = parseDbUri('mysql://u:' + encodeURIComponent('p@ss:w/1') + '@h/db')
    assert.equal(r.dbPassword, 'p@ss:w/1')
  })

  test('rediss 明确报错（表单无 ssl 字段，v1 边界）', () => {
    assert.throws(() => parseDbUri('rediss://h/0'), /rediss.*not supported/)
  })

  test('未知协议 / 空串 / 格式错误 明确报错', () => {
    assert.throws(() => parseDbUri('http://h/db'), /unsupported scheme: http/)
    assert.throws(() => parseDbUri('ftp://h'), /unsupported scheme: ftp/)
    assert.throws(() => parseDbUri(''), /empty/)
    assert.throws(() => parseDbUri('::::'), /invalid/)
    assert.throws(() => parseDbUri('mysql:///'), /missing host/)
  })

  test('标题级字段不含密码（parseDbUri 返回值仅列库表字段）', () => {
    const r = parseDbUri('mysql://u:p@h/db')
    const keys = Object.keys(r)
    assert.deepEqual(
      keys.sort(),
      ['dbName', 'dbHost', 'dbPassword', 'dbPort', 'dbType', 'dbUser'].sort()
    )
  })
})
