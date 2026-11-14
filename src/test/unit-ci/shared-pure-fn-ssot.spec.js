const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const CLIENT = path.join(ROOT, 'src/client')
const read = p => fs.readFileSync(p, 'utf8')
const src = rel => read(path.join(CLIENT, rel))

/**
 * 纯函数 / 限制常量的「单一真源」结构契约。
 *
 * 起因（2026-11-14）：关键字高亮的限制开关散在终端与 DB 网格两处，改一端就策略漂移；
 * 同轮排查又发现 isBinEnvelope 三份等价实现、escapeRegExp 两份、以及三个 vm 沙箱
 * 仍在注入早已无人读取的 maxHighlightLength/maxHits 假配置。
 * 本 spec 锁死「形状判定 / 转义工具 / 限制值只有一份定义」，允许 re-export 保 API。
 */
describe('共享纯函数与限制常量：SSOT 结构契约', async () => {
  const cw = src('common/db-column-width.js')
  const csv = src('common/db-csv.js')
  const renderers = src('components/database/value-renderers/index.js')
  const escape = src('common/escape-reg-exp.js')
  const gridReplace = src('common/db-grid-replace.js')
  const keys = src('components/terminal/automation/keys.js')

  test('isBinEnvelope 只有一份实现，其余两处 re-export', () => {
    assert.equal((cw.match(/export function isBinEnvelope \(/g) || []).length, 1,
      'db-column-width.js is the single implementation')
    for (const [name, body] of [['db-csv.js', csv], ['value-renderers', renderers]]) {
      assert.doesNotMatch(body, /function isBinEnvelope \(/, `${name} must not implement its own copy`)
      assert.match(body, /export \{ isBinEnvelope \}/, `${name} must re-export to keep its API`)
      assert.match(body, /from '.*db-column-width\.js'/, `${name} must import from the SSOT module`)
    }
  })

  // value-renderers/index.js 依赖无扩展名的 '../db-value-format'，node 下无法直接
  // import；它的 re-export 结构由上面的源码断言锁定，运行时一致性由
  // value-renderers.spec.js 的 vm 沙箱注入真实 SSOT 函数验证。
  test('db-csv 与 SSOT 的 isBinEnvelope 行为一致（re-export 没有指错模块）', async () => {
    const [{ isBinEnvelope: a }, { isBinEnvelope: b }] = await Promise.all([
      import('../../client/common/db-column-width.js'),
      import('../../client/common/db-csv.js')
    ])
    const samples = [
      null, undefined, 'x', 1, [], {},
      { __bin: null },
      { __bin: { size: 1, b64: 'AA==', truncated: false } },
      { __bin: { size: '1', b64: 'AA==', truncated: false } },
      { __bin: { size: 0, b64: '', truncated: true } }
    ]
    for (const v of samples) {
      assert.equal(a(v), b(v), 'db-csv must match SSOT')
    }
  })

  test('escapeRegExp 只有一份实现，其余两处 re-export', () => {
    assert.match(escape, /export function escapeRegExp \(/, 'escape-reg-exp.js is the single implementation')
    for (const [name, body] of [['db-grid-replace.js', gridReplace], ['keys.js', keys]]) {
      assert.doesNotMatch(body, /function escapeRegExp \(/, `${name} must not implement its own copy`)
      assert.match(body, /export \{ escapeRegExp \}/, `${name} must re-export to keep its API`)
      assert.match(body, /from '.*escape-reg-exp\.js'/, `${name} must import from the SSOT module`)
    }
  })

  test('两处 escapeRegExp 行为一致且保留空值保护', async () => {
    const [{ escapeRegExp: a }, { escapeRegExp: b }, { escapeRegExp: c }] = await Promise.all([
      import('../../client/common/escape-reg-exp.js'),
      import('../../client/common/db-grid-replace.js'),
      import('../../client/components/terminal/automation/keys.js')
    ])
    assert.equal(a('a.b*c'), 'a\\.b\\*c')
    for (const v of ['a.b*c', '[x]{2}', '', null, undefined]) {
      assert.equal(a(v), b(v), 'db-grid-replace must match SSOT')
      assert.equal(a(v), c(v), 'keys must match SSOT')
    }
  })

  test('同名常量消歧：watcher 命令上限不再叫 MAX_COMMAND_LENGTH', () => {
    const watcher = src('common/custom-watcher.js')
    // MAX_COMMAND_LENGTH 在 MCP 校验（client/app 镜像，有对照 spec）里是「server command」，
    // 与 watcher 命令截断长度是不同概念，且值 512 vs 2000 不同，不该同名。
    assert.doesNotMatch(watcher, /MAX_COMMAND_LENGTH/)
    assert.match(watcher, /MAX_WATCHER_COMMAND_LENGTH/)
  })

  test('vm 沙箱不再注入无人读取的裸限制值', () => {
    const specs = [
      'perf-guard.spec.js',
      'keyword-presets.spec.js',
      'db-highlight-length.spec.js'
    ]
    for (const name of specs) {
      const body = read(path.join(ROOT, 'src/test/unit-ci', name))
      // highlightValue 现在只从 resolveHighlightOptions(SSOT) 取限制；沙箱再注入
      // maxHighlightLength/maxHits 是假配置，会让人误以为改这里能调预算。
      assert.doesNotMatch(body, /maxHighlightLength:\s*4096/, `${name} must not inject a dead limit`)
      assert.doesNotMatch(body, /maxHits:\s*200\b/, `${name} must not inject a dead hit cap`)
      assert.match(body, /resolveHighlightOptions/, `${name} must use the real SSOT resolver`)
    }
  })

  test('产品代码里覆盖率阈值只有 SSOT 一处数字定义', () => {
    const limits = src('common/keyword-limits.js')
    assert.match(limits, /coverageThreshold:\s*0\.6\b/, 'product default stays 0.6')
    const scan = src('common/keyword-scan.js')
    assert.match(scan, /defaultCoverageThreshold\s*=\s*HIGHLIGHT_LIMITS\.coverageThreshold/)
    assert.doesNotMatch(scan, /= 0\.35\b|= 0\.6\b/, 'scan layer must not define a second value')
  })
})
