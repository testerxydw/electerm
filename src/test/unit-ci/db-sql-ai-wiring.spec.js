// AI 第一批「让 AI 的产出能进编辑器」的接线契约。
//
// 纯函数部分在 db-sql-ai.spec.js 里；这里钉的是**组件侧不能悄悄退化**的几条：
// - AI 的产出只能落到编辑器，不能拿到执行路径（不碰 runSql）；
// - 落编辑器走 CM6 dispatch（保留撤销栈），不是回写全文；
// - SQL 代码块不给"在终端运行"；
// - 递交给 AI 面板不再靠 setTimeout 猜挂载时机；
// - 历史裁剪保新不保旧；输入法组字的回车不发送。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SESSION = read('src/client/components/database/db-session.jsx')
const EDITOR = read('src/client/components/database/db-sql-editor.jsx')
const OUTPUT = read('src/client/components/ai/ai-output.jsx')
const CHAT = read('src/client/components/ai/ai-chat.jsx')
const STORE = read('src/client/store/common.js')
const LOCALES = read('src/app/common/locales-extra.js')

describe('db-sql-ai 接线：会话页登记编辑器目标', () => {
  test('挂载登记、卸载按同一句柄注销（不能无条件按 tabId 删）', () => {
    assert.match(SESSION, /registerSqlTarget\(tabId, sqlAiTarget\)/, '没有登记目标')
    assert.match(SESSION, /unregisterSqlTarget\(tabId, sqlAiTarget\)/, '没有反注册')
    // 严格模式/热更：先注册新句柄再跑旧清理，无条件 delete 会把新的删掉
    const target = read('src/client/common/db-sql-ai-target.js')
    assert.match(target, /targets\.get\(tabId\) === target/, '注销没做"只删自己这一份"的判断')
  })

  test('redis 不登记目标（它没有 SQL 编辑器）', () => {
    const at = SESSION.indexOf('registerSqlTarget(tabId')
    const block = SESSION.slice(Math.max(0, at - 500), at)
    assert.match(block, /if \(isRedis\)\s*\{\s*return/, 'redis 应该跳过登记')
  })

  test('目标契约只有写编辑器与读上下文，不含执行', () => {
    assert.match(SESSION, /insertSql \(text, plan\)/, '没有 insertSql')
    assert.match(SESSION, /getContext: \(\) => sqlAiCtxRef\.current/, '没有 getContext')
    // 登记出去的那段对象里不能出现 runSql —— 有就等于给 AI 开了执行通道
    const body = SESSION.slice(
      SESSION.indexOf('const sqlAiTarget = useMemo'),
      SESSION.indexOf('const sqlAiTarget = useMemo') + 2200)
    assert.ok(!/runSql/.test(body), '目标契约里不得暴露执行入口')
  })

  test('插入区间在落那一刻按编辑器实时状态重算，并走 planSqlInsertion', () => {
    const fn = SESSION.slice(
      SESSION.indexOf('const insertAiSql'),
      SESSION.indexOf('const insertAiSql') + 900)
    assert.match(fn, /editor\.getValue\(\)/, '没取实时全文，区间会错位')
    assert.match(fn, /editor\.getSelectionRange/, '没取实时选区')
    assert.match(fn, /planSqlInsertion\(\{[\s\S]*strategy: strategy \|\| 'auto'/, '策略没传给纯函数')
    assert.match(fn, /sqlAiTarget\.insertSql\(text, plan\)/, '没走目标插入')
    assert.ok(!/runSql/.test(fn), 'AI 插入路径不得执行 SQL')
  })

  test('三个入口：工具栏生成/优化 + 错误条修复；优化与解释都选区优先', () => {
    assert.match(SESSION, /onClick=\{\(\) => openSqlAi\('generate'\)\}/, '没有 AI 生成入口')
    assert.match(SESSION, /onClick=\{\(\) => openSqlAi\('optimize'\)\}/, '没有 AI 优化入口')
    assert.match(SESSION, /onClick=\{\(\) => openSqlAi\('fix'\)\}/, '错误条没有 AI 修复入口')
    assert.match(SESSION, /error: mode === 'fix' \? \(sqlResult\.error \|\| ''\) : ''/, '修复没带错误原文')
    assert.match(SESSION, /const sel = editor && editor\.getSelectionText \? editor\.getSelectionText\(\) : ''/,
      '打开弹层时没快照选区')
  })

  test('解释入口改为带上下文递交，不再用魔法延时', () => {
    const fn = SESSION.slice(
      SESSION.indexOf('const askAiAboutSql'),
      SESSION.indexOf('const askAiAboutSql') + 1200)
    assert.match(fn, /buildSqlAiPrompt\(\{[\s\S]*mode: 'explain'/, '提示词没走纯函数')
    assert.match(fn, /selection,/, '没把选区交给提示词（整段照旧会盖掉选区）')
    assert.match(fn, /language: \(window\.store\.config \|\| \{\}\)\.languageAI/, '回复语言没跟配置走')
    assert.match(fn, /window\.store\.setPendingAiPrompt\(built\.prompt\)/, '没走待填 prompt 状态')
    assert.ok(!/setTimeout/.test(fn), '解释入口还在猜面板挂载时间')
    assert.ok(!/请解释以下 SQL/.test(SESSION), '还留着硬编码中文提示词')
  })
})

describe('db-sql-ai 接线：编辑器句柄', () => {
  test('replaceRange 走 dispatch（保留撤销栈），不做全文回写', () => {
    const fn = EDITOR.slice(EDITOR.indexOf('replaceRange (text, start, end)'),
      EDITOR.indexOf('replaceRange (text, start, end)') + 700)
    assert.match(fn, /view\.dispatch\(\{[\s\S]*changes: \{ from, to, insert: text \}/, '没有 dispatch 区间替换')
    assert.match(fn, /selection: \{ anchor: from \+ text\.length \}/, '插入后光标没落到文本尾部')
    assert.ok(!/onChange/.test(fn), '区间替换不该退化成回写全文')
    // 越界偏移必须夹紧：AI 给的区间来自另一份文档快照
    assert.match(fn, /Math\.max\(0, Math\.min\(Number\(v\) \|\| 0, len\)\)/, '没有夹越界偏移')
  })

  test('getSelectionRange 与 getValue 同源（同一份文档的偏移才对得上）', () => {
    assert.match(EDITOR, /getSelectionRange \(\)[\s\S]*\{ start: s\.from, end: s\.to \}/,
      '没有返回选区区间')
  })
})

describe('db-sql-ai 接线：AI 回复代码块', () => {
  test('SQL 块给"插入编辑器"，并且不给"在终端运行"', () => {
    assert.match(OUTPUT, /isSqlBlock[\s\S]*\?\s*\(\s*<ImportOutlined/, 'SQL 块没有插入按钮')
    assert.match(OUTPUT, /<PlayCircleOutlined[\s\S]*onClick=\{runInTerminal\}/, '非 SQL 仍要能终端运行')
    // 两个动作互斥：SQL 分支里不能再出现终端运行
    const branch = OUTPUT.slice(OUTPUT.indexOf('{'), OUTPUT.indexOf('</div>\n        <pre>'))
    const sqlIdx = branch.indexOf('<ImportOutlined')
    const runIdx = branch.indexOf('<PlayCircleOutlined')
    assert.ok(sqlIdx >= 0 && runIdx > sqlIdx, '插入/终端运行不是互斥分支')
    assert.match(OUTPUT, /SQL_LANG_RE\.test\(className\) \|\| looksLikeSql\(code\)/,
      'SQL 判定既要认围栏标注也要能认裸 SQL')
  })

  test('目标在点击时解析（历史条目是 memo 的，渲染期解析会拿到过期可用性）', () => {
    assert.match(OUTPUT, /const target = getActiveSqlTarget\(\)/, '没有按活动 tab 取目标')
    assert.match(OUTPUT, /strategy: 'cursor'/,
      '对话里插入必须是光标插入：不能悄悄吃掉编辑器里的既有选区')
    assert.match(OUTPUT, /message\.warning\(e\('dbAiInsertNoTarget'\)\)/, '没有目标时要有说明')
  })
})

describe('db-sql-ai 接线：AI 面板三个既有缺陷', () => {
  test('历史裁剪保新不保旧', () => {
    assert.match(CHAT, /aiChatHistory\.slice\(-MAX_HISTORY\)/, '仍在保头去尾：会丢掉刚发的那条')
    // 只禁代码形态，注释里允许出现这个旧写法（它就是解释"为什么改"的说明）
    assert.ok(!/= window\.store\.aiChatHistory\.slice\(0, MAX_HISTORY\)/.test(CHAT),
      '还留着 slice(0, MAX_HISTORY) 的赋值')
  })

  test('输入法组字中的回车不发送', () => {
    assert.match(CHAT, /evt\.nativeEvent\.isComposing \|\| evt\.keyCode === 229/, '没有 isComposing 守卫')
  })

  test('附件去重看内容指纹，不看 name+size', () => {
    assert.match(CHAT, /isDuplicateAttachment\(next, attachment\)/, '去重没走指纹')
    const att = read('src/client/components/ai/ai-attachments.js')
    assert.match(att, /attachment\.fingerprint = attachmentFingerprint\(attachment\)/, '读取时没算指纹')
  })

  test('外部递交的 prompt 由面板消费一次；带文本直接发送，不动输入框草稿', () => {
    assert.match(CHAT, /props\.pendingAiPrompt/, '面板没接待填 prompt')
    assert.match(CHAT, /handleSubmit\(p\.text\)/, 'autoSubmit 时没把文本直接交给提交')
    assert.match(CHAT, /window\.store\.pendingAiPrompt = null/, '消费后没清空')
    assert.match(STORE, /Store\.prototype\.setPendingAiPrompt = function/, 'store 没有递交入口')
    assert.ok(!/setTimeout\(\(\) => \{\s*refsStatic\.get\('AIChat'\)/.test(STORE), 'explainWithAi 还在猜延时')
  })

  test('override 提交不带面板附件、也不清空草稿', () => {
    const submit = CHAT.slice(
      CHAT.indexOf('const handleSubmit'),
      CHAT.indexOf('const handleSubmit') + 3000)
    assert.match(submit, /const entryAttachments = isOverride/, 'override 应忽略面板里的附件')
    assert.match(submit, /if \(!isOverride\) \{[\s\S]*setPrompt\(''\)[\s\S]*setAttachments\(\[\]\)/,
      'override 不该清掉用户正在写的草稿')
    assert.match(submit, /const text = isOverride \? overridePrompt : prompt/,
      '提交文本没走 override')
  })
})

describe('db-sql-ai 接线：词条补齐（locales 缺项会直接露出驼峰 key）', () => {
  const KEYS = [
    'dbAiGen', 'dbAiOptimize', 'dbAiFix', 'dbCopyError',
    'dbAiGenTitle', 'dbAiFixTitle', 'dbAiOptTitle',
    'dbAiActionGenerate', 'dbAiActionFix', 'dbAiActionOptimize', 'dbAiActionAgain',
    'dbAiInstructionPh', 'dbAiExtraPh', 'dbAiNeedInstruction', 'dbAiRequestFailed',
    'dbAiWaiting', 'dbAiPreview', 'dbAiNoSqlInReply', 'dbAiRiskPrefix',
    'dbAiInsert', 'dbAiInsertNoTarget', 'dbAiInserted', 'dbAiInsertedAll',
    'dbAiStrategyAuto', 'dbAiStrategyCursor', 'dbAiStrategyReplace', 'dbAiInsertHint',
    'aiAttachmentTooBig', 'aiAttachmentTextOnly'
  ]
  KEYS.forEach(k => {
    test(`${k} 英文与中文都在`, () => {
      const hits = LOCALES.split('\n').filter(l => l.trim().startsWith(k + ':')).length
      assert.equal(hits, 2, `${k} 应出现两次（en + zh_cn），实际 ${hits} 次`)
    })
  })
})
