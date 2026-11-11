/**
 * T04 · 批准矩阵（M6，T04-01）+ 污染门（M6b，T04-03）· 纯函数直测。
 *
 * 被测模块不依赖 window / store，node 里真 ESM 直连 import（同
 * mcp-client-store-cancel.spec.js 的加载方式）。
 *
 * 判据出处：doc/验证-MCP-T04判据-lead草稿-2026-11-11.md T04-01 / T04-03；
 * 决策表原文：doc/已完成/设计-MCP-client-P0-1-2026-11-10.md §3.4（:573-584）。
 *
 * 变异自证（实现不许动判据，spec 必须能抓缺陷）：
 *   - 把 `auto`+无 hint 那格改成 requireApproval=true（实现者常"为安全顺手
 *     改"）→ T04-01 的 auto-cell 断言红；
 *   - 改掉 readonly 拦截态的 reason 字符串 / 删掉 reason 字段 → reason 断言红；
 *   - 把 `taint=false` 分支也返回 true（恒弹窗蒙混）→ T04-03 反向断言红；
 *   - 把 `list_tabs` 误列进 TAINT_GATED_BUILTIN_TOOLS（"tainted 后全都问"）
 *     → 非 TAINT_GATED 断言红 + 清单快照断言红。
 */

const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const GUARD = path.resolve(__dirname, '../../client/common/external-tool-guard.js')

async function loadGuard () {
  return import(pathToFileURL(GUARD).href)
}

// readOnlyHint 的载体：meta.annotations.readOnlyHint（manager.js meta 结构）
const metaWith = (readOnlyHint) => ({
  serverName: 'srv-a',
  originalName: 'read_file',
  annotations: readOnlyHint === undefined ? {} : { readOnlyHint }
})

describe('T04-01（M6）decideToolApproval 六格决策表 · 逐格断言（不抽样）', () => {
  let guard
  before(async () => {
    guard = await loadGuard()
  })

  it('格 1：readonly + readOnlyHint=true → 放行（false），无 reason', () => {
    const d = guard.decideToolApproval({ meta: metaWith(true), trust: 'readonly' })
    assert.equal(d.requireApproval, false)
    assert.equal(d.reason, undefined, '放行格不得携带 reason')
  })

  it('格 2：readonly + 无 hint → 拦截 + reason=trust-readonly-blocks-write（取消-only 的地基）', () => {
    const d = guard.decideToolApproval({ meta: metaWith(false), trust: 'readonly' })
    assert.equal(d.requireApproval, true)
    assert.equal(d.reason, 'trust-readonly-blocks-write')
  })

  it('格 2b：readonly + annotations 缺失 → 同格 2（hint 缺失按 false 处理）', () => {
    const d = guard.decideToolApproval({ meta: {}, trust: 'readonly' })
    assert.equal(d.requireApproval, true)
    assert.equal(d.reason, 'trust-readonly-blocks-write')
  })

  it('格 3：ask + readOnlyHint=true → 放行', () => {
    const d = guard.decideToolApproval({ meta: metaWith(true), trust: 'ask' })
    assert.equal(d.requireApproval, false)
  })

  it('格 4：ask + 无 hint → 拦截 + reason=no-readonly-hint', () => {
    const d = guard.decideToolApproval({ meta: metaWith(false), trust: 'ask' })
    assert.equal(d.requireApproval, true)
    assert.equal(d.reason, 'no-readonly-hint')
  })

  it('格 4b：ask + meta/trust 双缺省 → 拦截（默认 ask，config-validate.js:122 的默认值语义）', () => {
    const d = guard.decideToolApproval({})
    assert.equal(d.requireApproval, true)
    assert.equal(d.reason, 'no-readonly-hint')
  })

  it('格 5：auto + readOnlyHint=true → 放行', () => {
    const d = guard.decideToolApproval({ meta: metaWith(true), trust: 'auto' })
    assert.equal(d.requireApproval, false)
  })

  it('格 6（最易被"顺手改安全"的一格）：auto + 无 hint → 必须放行 requireApproval === false', () => {
    // 用户显式承担；实现者把它改成 true 不报错、不崩、还显得"更安全"，
    // 只有这条断言能拦住（判据 T04-01 变异靶点 ①）
    const d = guard.decideToolApproval({ meta: metaWith(false), trust: 'auto' })
    assert.equal(d.requireApproval, false, 'auto 档用户显式承担，必须放行——改 true 即判据红')
    assert.equal(d.reason, undefined)
  })

  it('签名不含 tainted：taint 维度由 requiresTaintApproval 独立承担（设计 §3.4 分离原则）', () => {
    // meta 里混入 tainted 也不影响决策——两个维度不许耦合
    const d = guard.decideToolApproval({ meta: { ...metaWith(false), tainted: true }, trust: 'ask' })
    assert.equal(d.requireApproval, true)
    assert.equal(d.reason, 'no-readonly-hint')
  })
})

describe('T04-03（M6b）requiresTaintApproval · 正面 + 三条反向', () => {
  let guard
  before(async () => {
    guard = await loadGuard()
  })

  const TAINT_GATED = ['sftp_upload', 'sftp_download', 'sftp_del', 'db_insert_sql']

  it('① 正面：taint=true 时 4 个 TAINT_GATED 内置写工具逐个返回 true', () => {
    for (const name of TAINT_GATED) {
      assert.equal(
        guard.requiresTaintApproval(name, true), true,
        `${name} 在 tainted run 里必须逐次确认（SEC-5）`
      )
    }
  })

  it('② 反向：taint=false 时 4 个工具都不弹（防"恒弹窗"实现蒙混）', () => {
    for (const name of TAINT_GATED) {
      assert.equal(
        guard.requiresTaintApproval(name, false), false,
        `${name} 未污染时不得拦（恒弹窗会让 agent 不可用）`
      )
    }
  })

  it('③ 反向：非 TAINT_GATED 的内置工具（list_tabs）在 taint=true 时也不弹', () => {
    assert.equal(guard.requiresTaintApproval('list_tabs', true), false)
    assert.equal(guard.requiresTaintApproval('run_command', true), false)
  })

  it('清单快照：TAINT_GATED_BUILTIN_TOOLS 恰好是这 4 个（误增误删即红）', () => {
    assert.deepEqual(
      [...guard.TAINT_GATED_BUILTIN_TOOLS].sort(),
      [...TAINT_GATED].sort()
    )
  })

  it('入参鲁棒：非字符串工具名 / truthy 非布尔 tainted 不抛错', () => {
    assert.equal(guard.requiresTaintApproval(undefined, true), false)
    assert.equal(guard.requiresTaintApproval(42, true), false)
    assert.equal(guard.requiresTaintApproval('sftp_upload', 'yes'), true, 'tainted 按真值语义')
  })
})
