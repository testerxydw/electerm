// U1 顶部工具条右侧分组：风险 / 系统库 / 连接动作
//
// 不重排左侧连接信息，只把右侧那排控件按语义切成三组、组间 1px 分隔线，
// 并把原来没有文字的两个开关补上标签与 aria-label（并排的开关只靠 tooltip
// 分不清哪个是只读、哪个是系统库）。本 spec 钉住结构与可访问性属性，
// 宽度表现由 self-test 的三档截图覆盖。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

// N11a-#16：顶部工具条已迁到 db-session-head-bar.jsx（已接线），
// 分组/aria/顺序断言改读「owner + 顶栏组件」组合源码
const SESSION = 'src/client/components/database/db-session.jsx'
const HEAD_BAR = 'src/client/components/database/db-session-head-bar.jsx'
const STYL = 'src/client/components/database/db-session.styl'

const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// 右侧工具区：从 .db-head-right 到窗口级动作 .db-head-actions 之前
const headRightBody = () => {
  const src = codeOf(read(SESSION) + "\n" + read(HEAD_BAR))
  const start = src.indexOf("<span className='db-head-right'>")
  const end = src.indexOf("<span className='db-head-actions'>")
  assert.ok(start !== -1 && end > start, '没找到 .db-head-right 区块')
  return src.slice(start, end)
}

describe('U1 顶部工具条右侧分组', () => {
  test('三组控件 + 两条分隔线，顺序是 风险 → 系统库 → 连接动作', () => {
    const body = headRightBody()
    assert.equal((body.match(/className='db-tool-group'/g) || []).length, 3, '组数')
    assert.equal((body.match(/className='db-tool-sep'/g) || []).length, 2, '分隔线数')
    const first = body.indexOf("className='db-tool-group'")
    const sep1 = body.indexOf("className='db-tool-sep'")
    const second = body.indexOf("className='db-tool-group'", first + 1)
    const sep2 = body.indexOf("className='db-tool-sep'", sep1 + 1)
    const third = body.indexOf("className='db-tool-group'", second + 1)
    assert.deepEqual([first < sep1, sep1 < second, second < sep2, sep2 < third],
      [true, true, true, true], '分组与分隔线的相对顺序')
  })

  test('风险组：生产标记、临时解除、只读开关同组（只读不再和刷新混在一排）', () => {
    const body = headRightBody()
    const riskEnd = body.indexOf("className='db-tool-sep'")
    const risk = body.slice(0, riskEnd)
    assert.match(risk, /db-prod-flag/)
    assert.match(risk, /db-prod-bypass/)
    assert.match(risk, /onChange=\{toggleReadonly\}/)
    assert.doesNotMatch(risk, /loadTree\(\)/, '刷新不属于风险组')
  })

  test('只读开关有可见标签和 aria-label（两个开关并排，不能只靠 tooltip 区分）', () => {
    const body = headRightBody()
    assert.match(body, /className='db-tool-label'>\{e\('readOnly'\)\}/)
    assert.match(body, /onChange=\{toggleReadonly\}\s*aria-label=\{e\('readOnly'\)\}/)
  })

  test('系统库开关也有 aria-label（图标/开关类控件都要可被读屏点出来）', () => {
    assert.match(codeOf(read(SESSION) + "\n" + read(HEAD_BAR)), /onChange=\{toggleSys\}\s*aria-label=\{e\('systemSchemas'\)\}/)
  })

  test('连接组：重连（仅错误时）在刷新之前，刷新按钮带 aria-label', () => {
    const body = headRightBody()
    const connStart = body.lastIndexOf("className='db-tool-group'")
    const conn = body.slice(connStart)
    assert.match(conn, /connError[\s\S]*?\{e\('reconnect'\)\}/)
    assert.ok(conn.indexOf("{e('reconnect')}") < conn.indexOf('loadTree()'), '重连在刷新前')
    assert.match(conn, /aria-label=\{e\('refresh'\)\}/)
  })

  test('分隔线用 --border token 而不是裸色值（CSS 契约）', () => {
    const styl = read(STYL)
    assert.match(styl, /\.db-tool-group\n\s+display inline-flex/)
    assert.match(styl, /\.db-tool-sep\n\s+flex none\n\s+width 1px\n\s+height 14px\n\s+background var\(--border\)/)
  })
})
