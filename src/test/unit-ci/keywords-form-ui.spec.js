const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/setting-panel/keywords-form.jsx')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

// 关键字高亮"新增规则 / 新建分组"UI 接线契约（无 DOM 渲染设施，按
// db-grid-scroll.spec.js 口径：抽真实源码做漂移守卫）。
// 回归背景：
//  - 用户分组为空时整个用户区没有任何新增入口（只能靠导入）
//  - 具名分组没有新增按钮
//  - 用户区收起时点"新建分组"，组名输入框渲染在收起的 body 里不出现
//  - Input 的 enter 后紧跟 blur 会双触发 commit，必须用 ref 哨兵拦一次

const loadJsx = () => fs.readFileSync(JSX, 'utf8')
const loadLocales = () => fs.readFileSync(LOCALES, 'utf8')

describe('keywords form: add rule / create group wiring (real source)', () => {
  test('kwAddGroup locale key exists in both en and zh blocks', () => {
    const keys = loadLocales().match(/kwAddGroup:/g) || []
    assert.equal(keys.length, 2, 'kwAddGroup must exist in en_US and zh_CN blocks')
  })

  test('create-group button handler expands the user section (collapse bug)', () => {
    const src = loadJsx()
    const btn = src.match(/className='kw-add-group'[\s\S]*?<\/Button>/)
    assert.ok(btn, 'kw-add-group button not found')
    assert.match(btn[0], /stopPropagation/, 'must not toggle the section head')
    assert.match(btn[0], /setOpenSec\(/, 'collapsed section must auto-expand on create-group click')
    assert.match(btn[0], /setAddingGroup\(true\)/)
    assert.match(btn[0], /addGroupRef\.current = true/, 'arm the enter/blur double-fire sentinel')
  })

  test('commitAddGroup: sentinel guard, duplicate check, creates rule in the group', () => {
    const fn = loadJsx().match(/const commitAddGroup = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(fn, 'commitAddGroup not found')
    const body = fn[0]
    assert.match(body, /if \(!addGroupRef\.current\) \{/, 'enter+blur double-fire must be guarded once')
    assert.match(body, /addGroupRef\.current = false/, 'sentinel must be consumed')
    assert.match(body, /kwGroupNameExists/, 'duplicate group name must be rejected')
    assert.match(body, /trim\(\)/, 'empty name aborts creation')
    assert.match(body, /addUserRule\(list, \{ group: name \}\)/, 'create = one empty rule in the new group')
  })

  test('group name input is rendered inside the section body when adding', () => {
    const src = loadJsx()
    const body = src.match(/openSec\.user\s*\?[\s\S]*?\n {12}: null/)
    assert.ok(body, 'user section body block not found')
    assert.match(body[0], /addingGroup/, 'name input is gated on addingGroup')
    assert.match(body[0], /kwGroupName/, 'input must show the group-name placeholder')
    assert.match(body[0], /commitAddGroup/, 'input commits via commitAddGroup')
  })

  test('addUser helper auto-expands section and target group', () => {
    const fn = loadJsx().match(/const addUser = \(group = ''\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(fn, 'addUser helper not found')
    assert.match(fn[0], /setOpenSec\(/, 'empty-state add must open the user section')
    assert.match(fn[0], /setOpenGrp\(/, 'must expand the target group')
    assert.match(fn[0], /addUserRule\(list, \{ group \}\)/)
  })

  test('empty user section still offers an add-rule entry', () => {
    const src = loadJsx()
    const empty = src.match(/className='kw-empty'[\s\S]*?<\/div>/)
    assert.ok(empty, 'empty-state block not found')
    assert.match(empty[0], /kwNoRules/)
    assert.match(empty[0], /addUser\(''\)/, 'empty state must create a rule in the manual group')
  })

  test('named groups also render the add-rule button (not just the manual group)', () => {
    const rules = loadJsx().match(/<div className='kw-rules'>[\s\S]*?<\/div>\s*\)\s*:\s*null/)
    assert.ok(rules, 'kw-rules block in renderUserGroup not found')
    assert.match(rules[0], /addUser\(group\.name\)/, 'add button must target the current group')
    assert.ok(!/named\s*\?\s*null/.test(rules[0]), 'add button must not be gated on unnamed group only')
  })
})
