// N5a · Redis 命令控制台的接线契约（读发布源码本身，不另留一份拷贝）。
//
// 这一批的安全边界跨三层，最容易出的错不是"逻辑写错"而是"接线接歪"：
// - 渲染层自己分词/自己判只读 → 护栏交给了被约束的一方；
// - 主进程忘了注册 op / 忘了注入 useDb → 界面上看着能用，实际抛 unsupported op；
// - 原因码在组件里手写成字符串 → 与主进程的码分叉，用户看到空横幅；
// - 词条只加了 en → 中文界面直接暴露驼峰 key 原文。
// 所以这里逐条钉住"线是怎么接的"，逻辑本身由另外三份 spec 钉。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const INDEX = read('src/app/lib/db-client/index.js')
const REDIS = read('src/app/lib/db-client/redis.js')
const CONSOLE_OP = read('src/app/lib/db-client/redis-console.js')
const POLICY = read('src/app/lib/db-client/redis-command-policy.js')
const CLIENT_PURE = read('src/client/common/db-redis-console.js')
const HOOK = read('src/client/components/database/use-db-redis-console.js')
const JSX = read('src/client/components/database/db-redis-console.jsx')
const SESSION = read('src/client/components/database/db-session.jsx')
const KEY_SPACE = read('src/client/components/database/db-redis-key-space.jsx')
const STYL = read('src/client/components/database/db-session.styl')
const locales = require(path.join(ROOT, 'src/app/common/locales-extra.js'))

/** 取一个函数/块的源码片段：从 marker 起，到第一个顶格 `}` 为止 */
function block (src, marker) {
  const at = src.indexOf(marker)
  assert.ok(at >= 0, `源码里找不到 ${marker}`)
  const end = src.indexOf('\n}', at)
  return src.slice(at, end < 0 ? src.length : end)
}

/** 取 hook 里一个 useCallback 的 body（到它的依赖数组为止，不带上下一个回调） */
function hookCallback (src, name) {
  const at = src.indexOf(`const ${name} = useCallback`)
  assert.ok(at >= 0, `hook 里找不到 ${name}`)
  const end = src.indexOf('\n  }, [', at)
  return src.slice(at, end < 0 ? src.length : end)
}

describe('N5a 接线：主进程注册与权威只读位', () => {
  test('两个 op 都注册在 redis 适配器下（漏一个就是 unsupported op）', () => {
    const redisMap = block(INDEX, '  redis: {')
    assert.match(redisMap, /runRedisCommand: 'runRedisCommand'/)
    assert.match(redisMap, /listRedisCommands: 'listRedisCommands'/)
  })

  test('runRedisCommand 有显式超时档（阻塞/订阅类已在策略层无条件拒绝）', () => {
    assert.match(INDEX, /runRedisCommand: 60000/)
  })

  test('只读位由主进程注入，且覆盖渲染层传来的同名字段', () => {
    const safe = block(INDEX, '  const safeArgs = {')
    const spreadAt = safe.indexOf('...(args || {})')
    const overrideAt = safe.indexOf('readOnly: inst.readOnly')
    assert.ok(spreadAt >= 0 && overrideAt > spreadAt, '必须先展开 args 再覆盖 readOnly')
  })

  test('redis.js 只注入 useDb，判定与分词都在独立模块里', () => {
    assert.match(REDIS, /require\('\.\/redis-console'\)/)
    assert.match(REDIS, /redisConsole\.runRedisCommand\(conn, args, \{ useDb \}\)/)
    assert.match(REDIS, /redisConsole\.listRedisCommands\(conn, args, \{ useDb \}\)/)
    const exports = block(REDIS, 'module.exports = {')
    assert.match(exports, /\brunRedisCommand\b/)
    assert.match(exports, /\blistRedisCommands\b/)
    // 适配器的职责是"按类型读写键"，不许在这里另写一份分词/黑名单
    assert.ok(!/function tokenize/.test(REDIS))
    assert.ok(!/new Map\(\[\s*\n\s*\['flushdb'/.test(REDIS))
  })

  test('执行层自己不做判定：策略全部委托给 policy（同一份真相）', () => {
    assert.match(CONSOLE_OP, /require\('\.\/redis-command-policy'\)/)
    assert.match(CONSOLE_OP, /policy\.refuseByName\(/)
    assert.match(CONSOLE_OP, /policy\.evaluate\(/)
    assert.match(CONSOLE_OP, /policy\.readOnlyHint\(/)
    // 拒绝发生在 useDb 之前：第一遍命中就不建连、不 SELECT
    const run = block(CONSOLE_OP, 'async function runRedisCommand')
    assert.ok(run.indexOf('policy.refuseByName') < run.indexOf('await useDb'), '名字类拒绝必须在 useDb 之前')
    assert.ok(!/const BLOCKED = /.test(CONSOLE_OP), '黑名单只许在策略层定义一次')
    assert.match(POLICY, /const BLOCKED = new Map/)
  })
})

describe('N5a 接线：渲染层不持有判定权', () => {
  test('三个渲染层文件都不引用主进程模块（跨进程只能走 dbClientOp）', () => {
    // 只查 import/require 语句：注释里提到主进程模块名是口径说明，不是依赖
    for (const [name, src] of [['pure', CLIENT_PURE], ['hook', HOOK], ['jsx', JSX]]) {
      assert.ok(!/(from|require\()\s*['"][^'"]*redis-command-policy/.test(src), `${name} 不许 import 主进程策略`)
      assert.ok(!/(from|require\()\s*['"][^'"]*app\/lib\/db-client/.test(src), `${name} 不许 import 主进程执行层`)
    }
  })

  test('发出去的是整行原文，不是客户端自己挑的 command/args', () => {
    const at = HOOK.indexOf("'runRedisCommand', {")
    assert.ok(at > 0)
    const payload = HOOK.slice(at, HOOK.indexOf('})', at))
    assert.match(payload, /\bline\b/)
    assert.match(payload, /\bdbIndex\b/)
    assert.ok(!/command:/.test(payload), '客户端不许自己分词')
    assert.ok(!/args:/.test(payload))
    assert.ok(!/readOnly/.test(payload), '只读位由主进程注入，渲染层传什么都无效')
  })

  test('IPC 不在 state 更新函数里发（StrictMode 下 updater 跑两次 = 写命令做两遍）', () => {
    const all = HOOK.match(/window\.pre\.runGlobalAsync\(/g) || []
    const topLevel = HOOK.match(/^ {4}window\.pre\.runGlobalAsync\(/gm) || []
    assert.ok(all.length >= 2, '两个 op 各一处调用')
    assert.equal(all.length, topLevel.length, '每处调用都在 useCallback 体顶层，不在 updater 里')
    assert.match(HOOK, /const entriesRef = useRef\(\[\]\)/)
  })

  test('写命令走既有确认闸门，取消则一个 op 都不发', () => {
    assert.match(HOOK, /confirmRedisWrite\(\{/)
    assert.match(HOOK, /level: risk/)
    const run = hookCallback(HOOK, 'runRedisConsole')
    assert.ok(run.indexOf('confirmRedisWrite') < run.indexOf('send(text, dbIndex)', run.indexOf('confirmRedisWrite')))
    assert.match(run, /if \(ok\) \{/)
    // 档位来自客户端纯函数（它读的是主进程交下来的 write 三态），不在 hook 里另写名单
    assert.match(HOOK, /consoleRisk\(\{/)
    assert.ok(!/FLUSHALL|flushdb/.test(HOOK), 'hook 不许自带命令黑名单')
  })

  test('历史有上限、关闭不丢历史、命令表请求有防串扰令牌', () => {
    assert.match(HOOK, /const HISTORY_MAX = 50/)
    assert.match(HOOK, /\.slice\(0, HISTORY_MAX\)/)
    assert.match(HOOK, /listTokenRef/)
    const close = hookCallback(HOOK, 'closeRedisConsole')
    assert.ok(!/history: \[\]/.test(close), '关闭只收弹层，不清历史')
  })
})

describe('N5a 接线：弹层交互与呈现', () => {
  test('Enter 两种含义：有高亮候选先补全，否则执行', () => {
    assert.match(JSX, /if \(suggestOpen && active >= 0 && items\[active\]\)/)
    const enter = JSX.slice(JSX.indexOf("if (ev.key === 'Enter')"), JSX.indexOf("if (ev.key === 'Escape')"))
    assert.match(enter, /accept\(items\[active\]\)/)
    assert.match(enter, /onRun\(draft\)/)
  })

  test('Esc 只在补全列表开着时吃掉，否则照常关弹层', () => {
    const esc = JSX.slice(JSX.indexOf("if (ev.key === 'Escape')"))
    assert.match(esc, /if \(suggestOpen\)/)
    assert.match(esc, /ev\.stopPropagation\(\)/)
    assert.match(esc, /setDismissed\(true\)/)
  })

  test('鼠标接受用 onMouseDown + preventDefault（blur 先于 click，否则永远补不进去）', () => {
    assert.match(JSX, /onMouseDown=\{ev => \{/)
    assert.match(JSX, /ev\.preventDefault\(\)/)
    assert.match(JSX, /accept\(it\)/)
  })

  test('原因码只经映射表翻译，组件里不手写码字符串', () => {
    assert.match(JSX, /e\(consoleReasonKey\(res\.reason\)\)/)
    for (const code of ['readonly-refuse', 'destructive', 'unknown-command', 'connection-state', 'unterminated-quote']) {
      assert.ok(!JSX.includes(`'${code}'`), `组件里出现了裸原因码 ${code}`)
    }
  })

  test('两种截断分开说：主进程截的是数据，渲染层截的是没画出来', () => {
    assert.match(JSX, /res\.truncated/)
    assert.match(JSX, /dbRedisConsoleMainTruncated/)
    assert.match(JSX, /flat\.rowsTruncated/)
    assert.match(JSX, /dbRedisConsoleRowsTruncated/)
    assert.match(JSX, /String\(REPLY_VISIBLE_ROWS\)/)
    // 一条记录只摊平一次（几千项的回复上画两遍是能感觉出来的）
    assert.equal((JSX.match(/flattenReply\(/g) || []).length, 1)
  })

  test('回复按类型呈现，复制给的是完整文本', () => {
    assert.match(JSX, /replyHeader\(res\.reply, e\)/)
    assert.match(JSX, /copy\(replyToText\(res\.reply\)\)/)
    assert.match(JSX, /is-\$\{r\.kind\}/)
    assert.match(JSX, /paddingLeft: 8 \+ r\.depth \* 14/)
  })

  test('服务端错误回复画进历史，连接类失败走 ipcError 通道', () => {
    assert.match(JSX, /tone === 'error'/)
    assert.match(JSX, /\{res\.error\}/)
    assert.match(JSX, /h\.ipcError/)
    assert.match(JSX, /'conn'/)
  })

  test('只读态与"命令表拿不到"各有可见提示（不静默降级）', () => {
    assert.match(JSX, /isReadonly\s*\?/)
    assert.match(JSX, /dbRedisConsoleReadonly/)
    assert.match(JSX, /s\.listError/)
    assert.match(JSX, /dbRedisConsoleNoCommandList/)
    assert.match(JSX, /dbRedisConsoleFallbackSource/)
  })

  test('写标记与回落来源都来自服务端结论，客户端不自己判', () => {
    assert.match(JSX, /res\.write === true/)
    assert.match(JSX, /res\.source === 'fallback'/)
    assert.ok(!/FLUSH|isWriteCommand/.test(JSX))
  })
})

describe('N5a 接线：owner 与入口', () => {
  test('owner 注入边界量，弹层只在 Redis 页签挂载', () => {
    assert.match(SESSION, /import DbRedisConsoleModal from '\.\/db-redis-console'/)
    assert.match(SESSION, /import \{ useDbRedisConsole \} from '\.\/use-db-redis-console'/)
    const call = SESSION.slice(SESSION.indexOf('} = useDbRedisConsole({'), SESSION.indexOf('})', SESSION.indexOf('} = useDbRedisConsole({')))
    for (const injected of ['tabId', 'getRedisDb: () => redisDb', 'isReadonly', 'isProduction', 'confirmRedisWrite']) {
      assert.ok(call.includes(injected), `hook 缺注入 ${injected}`)
    }
    const modal = SESSION.slice(SESSION.indexOf('<DbRedisConsoleModal'), SESSION.indexOf('/>', SESSION.indexOf('<DbRedisConsoleModal')))
    for (const prop of ['state={redisConsole}', 'isReadonly={isReadonly}', 'dbIndex={redisDb}', 'onRun={runRedisConsole}', 'onDraftChange={setRedisConsoleDraft}', 'onReloadCommands={loadRedisConsoleCommands}', 'onClearHistory={clearRedisConsoleHistory}']) {
      assert.ok(modal.includes(prop), `弹层缺 prop ${prop}`)
    }
    // 挂载点在 isRedis 分支里（与 INFO 弹层同一族）
    const before = SESSION.slice(SESSION.lastIndexOf('{', SESSION.indexOf('<DbRedisConsoleModal')), SESSION.indexOf('<DbRedisConsoleModal'))
    assert.match(before, /isRedis/)
  })

  test('入口开在键列表工具条上，且只读下不禁用（拦截交给主进程按命令判）', () => {
    assert.match(KEY_SPACE, /openRedisConsole/)
    const at = KEY_SPACE.indexOf("className='db-redis-console-open'")
    assert.ok(at > 0)
    const btn = KEY_SPACE.slice(KEY_SPACE.lastIndexOf('<Button', at), KEY_SPACE.indexOf('>', at))
    assert.match(btn, /onClick=\{openRedisConsole\}/)
    assert.ok(!/disabled/.test(btn), '只读下仍要能敲读命令，禁用条件不该在这里')
    // owner 把入口交给键空间组件（弹层本体仍挂在 owner 上）
    assert.match(SESSION, /openRedisConsole\n\s*\}\}/)
  })
})

describe('N5a 接线：样式与词条', () => {
  test('补全列表在文档流内（输入行之后），不得 absolute 悬浮（假溢出会把 body 撑出双滚动条）', () => {
    assert.match(STYL, /^\.db-redis-console$/m)
    const suggest = STYL.slice(STYL.indexOf('  .db-redis-console-suggest\n'), STYL.indexOf('  .db-redis-console-mode'))
    // absolute 溢出后代计入 .ant-modal-body 的 scrollHeight：浮层一展开 body 就
    // 多出一条「假溢出」滚动条，与浮层自身滚动条并排（用户截图的双滚动条根因）。
    // 文档流定位后该断言反向锁定：suggest 块内禁止再写 position absolute。
    assert.doesNotMatch(suggest, /position absolute/)
    assert.match(suggest, /max-height 220px/)
    assert.match(suggest, /overflow auto/)
    assert.match(STYL, /\.db-redis-console-suggest-item/)
    assert.match(STYL, /&\.is-active/)
    assert.match(STYL, /&\.is-blocked/)
    assert.match(STYL, /\.db-redis-console-history/)
  })

  test('输入行钉在弹层顶部（sticky），历史不另开滚动通道（单通道 SSOT）', () => {
    // 输入行：sticky 钉顶，历史滚动时输入框与执行按钮不动
    const inputBlock = STYL.slice(
      STYL.indexOf('  .db-redis-console-input\n'),
      STYL.indexOf('  .db-redis-console-line')
    )
    assert.match(inputBlock, /position sticky/)
    assert.match(inputBlock, /top 0/)
    assert.match(inputBlock, /background var\(--main\)/)

    // 历史：不能自己限制高度/开 overflow，否则与弹层 body（modal-scroll.styl SSOT）
    // 形成双滚动条，且输入行会被滚走
    const historyBlock = STYL.slice(
      STYL.indexOf('  .db-redis-console-history\n'),
      STYL.indexOf('  .db-redis-console-entry')
    )
    assert.ok(!/overflow/.test(historyBlock), '历史区不得自带 overflow（滚动交回弹层 body）')
    assert.ok(!/max-height/.test(historyBlock), '历史区不得自带 max-height（单滚动通道）')
  })

  test('界面用到的每个控制台词条在 en 与 zh_cn 里都有，且没有多余孤儿键', () => {
    const used = new Set()
    for (const src of [JSX, HOOK, KEY_SPACE]) {
      for (const m of src.matchAll(/e\('(dbRedisConsole[A-Za-z]*)'\)/g)) {
        used.add(m[1])
      }
    }
    // 原因码词条由映射表间接引用（组件里是 e(it.hint) / e(consoleReasonKey(...))），
    // 从纯函数模块的表里取出来一并算进"用到"
    const reasonBlock = CLIENT_PURE.slice(
      CLIENT_PURE.indexOf('export const ConsoleReasonKey = {'),
      CLIENT_PURE.indexOf('export const consoleReasonKey')
    )
    for (const m of reasonBlock.matchAll(/'(dbRedisConsole[A-Za-z]*)'/g)) {
      used.add(m[1])
    }
    // 回复头部的量词也由纯模块间接引用（replyHeader(value, t) 里的 t('…')）
    for (const m of CLIENT_PURE.matchAll(/\bt\('(dbRedisConsole[A-Za-z]*)'\)/g)) {
      used.add(m[1])
    }
    const defined = Object.keys(locales.en).filter(k => k.startsWith('dbRedisConsole'))
    assert.ok(defined.length >= 25, `词条数量异常：${defined.length}`)
    for (const key of used) {
      assert.ok(defined.includes(key), `${key} 在源码里用了但 en 没定义`)
      assert.equal(typeof locales.zh_cn[key], 'string', `${key} 缺 zh_cn`)
      assert.ok(locales.zh_cn[key].trim(), `${key} 的 zh_cn 为空`)
      assert.ok(locales.en[key].trim(), `${key} 的 en 为空`)
    }
    for (const key of defined) {
      assert.equal(typeof locales.zh_cn[key], 'string', `${key} 只加了 en`)
      assert.ok(used.has(key), `${key} 定义了却没人用（孤儿词条）`)
    }
  })

  test('带占位符的词条保留 {n}（译文里丢了占位符就画不出行数）', () => {
    for (const lang of ['en', 'zh_cn']) {
      assert.match(locales[lang].dbRedisConsoleRowsTruncated, /\{n\}/)
      assert.match(locales[lang].dbRedisConsoleItemCount, /\{n\}/)
    }
  })
})
