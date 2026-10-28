/**
 * G1 广播输入依赖 SSH 书签上的 production 标记（与 E1 数据库连接同名字段）。
 * 这四处任意一处丢掉，广播默认目标就会把生产机当普通目标勾上 —— 所以用
 * 源码断言锁住（客户端 schema / 主进程 zod / 表单开关 / 表单默认值）。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = p => fs.readFileSync(path.resolve(__dirname, '../../..', p), 'utf8')

const clientSchema = read('src/client/common/bookmark-schemas.js')
const appSchema = read('src/app/common/bookmark-zod-schemas.js')
const sshFields = read('src/client/components/bookmark-form/config/ssh.js')
const commonFields = read('src/client/components/bookmark-form/config/common-fields.js')

const sshBlock = src => {
  const start = src.indexOf('sshBookmarkSchema = {')
  assert.notEqual(start, -1, 'sshBookmarkSchema must exist')
  const end = src.indexOf('\n}', start)
  assert.notEqual(end, -1, 'sshBookmarkSchema must be a closed object')
  return src.slice(start, end)
}

describe('ssh bookmark production flag (G1)', () => {
  it('client schema declares production as optional boolean', () => {
    assert.match(sshBlock(clientSchema), /production:\s*z\.boolean\(\)\.optional\(\)/)
  })

  it('main-process zod schema declares production too', () => {
    assert.match(sshBlock(appSchema), /production:\s*z\.boolean\(\)\.optional\(\)/)
  })

  it('ssh settings tab exposes the switch and its explanation', () => {
    assert.match(commonFields, /name:\s*'production'/)
    assert.match(commonFields, /name:\s*'productionHint'/)
  })

  it('ssh form seeds production: false so the switch starts off', () => {
    assert.match(sshFields, /production:\s*false/)
  })
})
