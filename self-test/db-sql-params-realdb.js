#!/usr/bin/env node
/**
 * H6a 参数化查询 —— 真库 CDP 验收（MariaDB/MySQL，只读）
 *
 * 桩库（db-sql-params-demo.js）能证明"界面把值收到、把 params 数组发出去"，
 * 证明不了**值落到真驱动之后是什么形态**。这份跑真实链路：
 * 渲染层 :name → 占位符 SQL + params → 主进程 mysql2 → 真服务端。
 *
 * 只有真库才验得到的四件事：
 *   1) 引号/分号/`--` 当值绑进去，服务端把它当**数据**（0 行、不报错）；一旦有人
 *      改成拼接，这条会直接变成"返回整窗行"或语法错误。
 *   2) 反斜杠：MySQL 系默认允许串内转义。绑定 → `CHAR_LENGTH` 是 3；拼接 →
 *      服务端把 `'a\b'` 读成 2 个字符。桩里没有服务端，看不出来。
 *   3) 勾 NULL 发的是**真 null**（`SELECT ? IS NULL` 回 1，空串回 0）——
 *      只有真执行一次才分得清"没发"与"发了 null"。
 *   4) 只读页签下参数化 SELECT 照常跑：白名单吃的是转换后的占位符文本，
 *      不是含 :name 的用户原文（规则写错会一律拒掉）。
 *
 * 参照系不是产品实现的拷贝：命中行数与逐行 id 交给**数据库自己**按同一条占位符
 * SQL + 同一组参数算（oracle()），页面只报数字与哈希；占位符文本是脚本写死的
 * 期望值，用来钉住产品的转换结果。
 *
 * 对生产库的护栏（本脚本自约束）：
 *   · 页签以 readOnly: true 打开（主进程白名单为权威），只放行 SELECT；
 *   · 任何离开本脚本的文本先过 assertSelectOnly：非 SELECT 起始 / 含分号 /
 *     含写或 DDL 关键字 → 直接抛，不进页面；
 *   · tgfsom_operation_log 的 parameter 列有口令散列：只取 4 个安全列，且只扫
 *     主键尾部 2 万行窗口；判据输出不含单元格原文与参数值原文，
 *     只有数字、布尔、长度、djb2 哈希；
 *   · 截图目录 self-test/db-sql-params-realdb-shots/ 在 .gitignore 里。
 *
 * 用法：
 *   1) npm run vite-build（改了 src/app 还要 rsync 到 work/app 并重启实例）
 *   2) 起带 --remote-debugging-port 的实例（本机为 9225）
 *   3) RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *      node self-test/db-sql-params-realdb.js [debugPort] [shotDir]
 */
const path = require('node:path')
const mysql = require('mysql2/promise')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-params-realdb-shots')
const SPLIT_KEY = 'electerm-db-sql-params-realdb-split'
const TABLE = 'tgfsom_operation_log'
const COLS = 'id, operate_type, level, status'
const WINDOW = 20000
const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check, skip } = makeChecker()

const ENV = {
  host: process.env.RDB_MYSQL_HOST,
  port: process.env.RDB_MYSQL_PORT,
  user: process.env.RDB_MYSQL_USER,
  pass: process.env.RDB_MYSQL_PASS,
  db: process.env.RDB_MYSQL_DB
}

// 判据名集中在这里：缺凭据时逐条 SKIP 用的就是同一份名单，不会和实际跑的分叉
const L = {
  A0: 'A0 渲染进程重载到干净上下文（没有别的脚本留下的 runGlobalAsync 桩）',
  A1: 'A1 真库页签（只读）建连：树里有库名、无整页连接错误',
  A2: 'A2 选中样本表进入 SQL 页、执行探针安装成功',
  A3: 'A3 参数开关在位且默认开（只读真库页签）',
  B1: 'B1 点执行先弹参数面板：初值全空、弹窗期间一次请求都没发',
  B2: 'B2 面板按出现顺序给两行（:lv、:from），填进去的值各自生效',
  B3: 'B3 面板标题与提示是词条（讲清"值不拼进 SQL"，无未替换占位符）',
  B4: 'B4 真链路上服务端收到的是占位符 SQL（两个 ?，:lv 不在文本里）',
  B5: 'B5 值走独立 params 数组（长度 2），SQL 文本里没有值原文',
  B6: 'B6 结果 5 行 4 列、无错误告警（只读页签下参数化 SELECT 放行）',
  B7: 'B7 逐行 id 哈希与数据库自算参照一致（值确实进了谓词、顺序也对）',
  B8: 'B8 状态行给出真实耗时（主进程 elapsedMs 在参数化路径上同样回传）',
  C1: 'C1 同名 :lv 只问一行、字面量里的 :zzz 不抽参；占位符展开成 2 个',
  C2: 'C2 参照一致：operate_type <> :lv 复用同一个值，行数与 id 哈希对得上',
  D1: 'D1 注入值 x\' OR 1=1-- 只当数据：0 行、无报错、与参照一致',
  D2: 'D2 反斜杠+引号注入值同样 0 行且不报语法错误',
  D3: 'D3 正控制：绑真存在的 operate_type 有行且与参照一致',
  D4: 'D4 反斜杠按数据送达：CHAR_LENGTH(:k)=3 且等值成立',
  E1: 'E1 勾 NULL 后输入框禁用、面板行仍在（NULL ≠ 留空）',
  E2: 'E2 真 null 送达服务端：SELECT :v IS NULL 回 1',
  E3: 'E3 空串与 null 分得开：IS NULL 回 0、= \'\' 回 1',
  F1: 'F1 历史存用户原文（含 :lv/:from、不是展开后的 ?），参数值一条都不进历史；同条重跑不增行',
  F2: 'F2 再执行带出上次填的值（memo 只在当前 tab 内存）',
  F3: 'F3 取消 = 零执行：请求数不变、结果区还是上一次',
  G0: 'G0 面板在真库页签上可再次打开（浅/深色比色的前置）',
  G1: 'G1 浅色主题下参数名/提示色跟着 token 变（不是写死的深色值）'
}

// —— 只读护栏 ——
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|rename|call|execute|set|lock|unlock|load|kill|shutdown|handler|commit|rollback|savepoint|prepare|deallocate)\b/i
const assertSelectOnly = sql => {
  const s = String(sql).trim().replace(/;+$/, '')
  if (!/^select\b/i.test(s)) {
    throw new Error('非 SELECT 起始，拒绝发往真库: ' + s.slice(0, 40))
  }
  if (s.indexOf(';') >= 0) {
    throw new Error('检测到分号（多语句拼接），拒绝发往真库')
  }
  const bad = WRITE_WORDS.exec(s)
  if (bad) {
    throw new Error('语句含写/DDL 关键字 ' + bad[1] + '，拒绝发往真库')
  }
  return s
}

const djb2 = s => {
  let h = 5381
  const t = String(s === null || s === undefined ? '' : s)
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0
  }
  return h
}

const pick = (o, keys) => {
  const r = {}
  for (const k of keys) {
    r[k] = o && o[k]
  }
  return r
}

// 用户原文（含 :name）与"产品应当发给服务端的占位符文本"（脚本写死的期望值）
const SQL_TWO = 'SELECT ' + COLS + ' FROM ' + TABLE +
  ' WHERE level = :lv AND id > :from ORDER BY id DESC LIMIT 5'
const PH_TWO = 'SELECT ' + COLS + ' FROM ' + TABLE +
  ' WHERE level = ? AND id > ? ORDER BY id DESC LIMIT 5'
const SQL_TYPE = 'SELECT ' + COLS + ' FROM ' + TABLE +
  ' WHERE operate_type = :t AND id > :from ORDER BY id DESC LIMIT 4'
const PH_TYPE = 'SELECT ' + COLS + ' FROM ' + TABLE +
  ' WHERE operate_type = ? AND id > ? ORDER BY id DESC LIMIT 4'
// SQL 里的 'a\\b' 是"两个反斜杠"的字面写法：绑定应送达 3 字符 a\b
const SQL_ESC = "SELECT CHAR_LENGTH(:k) AS klen, :k = 'a\\\\b' AS is_eq"
const PH_ESC = "SELECT CHAR_LENGTH(?) AS klen, ? = 'a\\\\b' AS is_eq"
const SQL_NULL = 'SELECT :v IS NULL AS is_null, (:v = \'\') AS is_empty'
const PH_NULL = 'SELECT ? IS NULL AS is_null, (? = \'\') AS is_empty'

const INJ_A = "x' OR 1=1--"
const INJ_B = "\\' OR '1'='1"
const BACKSLASH = 'a\\b'

let conn = null
const openedTabs = []
const cfg0 = { theme: null, locale: null, split: null }
let cdpRef = null

const connect = async () => {
  if (conn) {
    return conn
  }
  conn = await mysql.createConnection({
    host: ENV.host,
    port: Number(ENV.port),
    user: ENV.user,
    password: ENV.pass,
    database: ENV.db,
    connectTimeout: 15000
  })
  return conn
}

// 参照：同一条占位符 SQL、同一组参数，交给数据库算
const oracle = async (phSql, params) => {
  const c = await connect()
  const [rows] = await c.query(assertSelectOnly(phSql), params)
  const keys = rows.length ? Object.keys(rows[0]) : []
  return {
    n: rows.length,
    idHashes: rows.map(r => djb2(r.id)),
    cells: rows.map(r => keys.map(k => (r[k] === null ? 'NULL' : String(r[k]))))
  }
}

const HELPERS_EXTRA = `
(() => {
  window.djb2 = s => {
    let h = 5381
    const t = String(s === null || s === undefined ? '' : s)
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
    return h
  }
  // —— 透传探针：不改写调用，只记下"服务端收到了什么、这一趟成没成" ——
  window.__spyDone = 0
  window.__spy = []
  window.__spyInstall = () => {
    if (window.__spyDone) return 'already'
    const orig = window.pre.runGlobalAsync.bind(window.pre)
    window.__spyOrig = orig
    window.pre.runGlobalAsync = function (name, ...a) {
      const p = orig(name, ...a)
      if (name === 'dbClientOp' && a[1] === 'executeSql') {
        const args = a[2] || {}
        const rec = {
          sql: String(args.sql || ''),
          pn: Array.isArray(args.params) ? args.params.length : -1,
          db: String(args.database || ''),
          hasNull: Array.isArray(args.params) && args.params.some(v => v === null),
          done: 0, err: 0, ms: null, sets: null
        }
        window.__spy.push(rec)
        Promise.resolve(p).then(r => {
          rec.done = 1
          rec.sets = Array.isArray(r && r.results) ? r.results.length : null
          rec.ms = r && Number.isFinite(Number(r.elapsedMs)) ? Number(r.elapsedMs) : null
        }, err => {
          rec.done = 1
          rec.err = 1
          rec.errHash = window.djb2(String((err && err.message) || err))
        })
      }
      return p
    }
    window.__spyDone = 1
    return 'ok'
  }
  window.__spyRestore = () => {
    if (window.__spyOrig) window.pre.runGlobalAsync = window.__spyOrig
    window.__spyDone = 0
    return 'ok'
  }
  window.__spyN = () => window.__spy.length
  window.__spyLast = () => JSON.stringify(window.__spy[window.__spy.length - 1] || null)
  window.__spySettled = () => {
    const l = window.__spy[window.__spy.length - 1]
    return !!(l && l.done)
  }
  window.__barBtn = re => [...document.querySelectorAll('.db-sql-bar button')]
    .filter(window.__vis).find(b => re.test(b.innerText.replace(/\\s/g, ''))) || null
  window.__paramBtn = () => window.__barBtn(/^(参数|params)$/i)
  window.__paramModeOn = () => {
    const b = window.__paramBtn()
    return b ? b.className.indexOf('ant-btn-primary') >= 0 : null
  }
  window.__paramRoot = () => window.__one('.db-params')
  window.__paramOpen = () => !!window.__paramRoot()
  window.__paramInput = row => row.querySelector('.db-params-input input') ||
    row.querySelector('.db-params-input')
  // 值原文不进 node：只给哈希与"是否空"
  window.__paramRows = () => {
    const r = window.__paramRoot()
    if (!r) return []
    return [...r.querySelectorAll('.db-params-row')].filter(window.__vis).map(row => {
      const input = window.__paramInput(row)
      const box = row.querySelector('.db-params-null input')
      return {
        name: (row.querySelector('.db-params-name').innerText || '').trim(),
        vh: input ? window.djb2(input.value) : null,
        empty: input ? input.value === '' : null,
        disabled: input ? !!input.disabled : null,
        nullChecked: box ? !!box.checked : null
      }
    })
  }
  window.__paramXY = (i, which) => {
    const rows = [...window.__paramRoot().querySelectorAll('.db-params-row')].filter(window.__vis)
    const row = rows[i]
    if (!row) return JSON.stringify({ error: 'no-row:' + i })
    const el = which === 'null'
      ? row.querySelector('.db-params-null input')
      : window.__paramInput(row)
    if (!el) return JSON.stringify({ error: 'no-el:' + which })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  window.__paramFooter = re => {
    const r = window.__paramRoot()
    if (!r) return 'no-root'
    const box = r.closest('.ant-modal-container') || document
    const norm = x => String(x.innerText).split(' ').join('')
    const b = [...box.querySelectorAll('.ant-modal-footer button')].find(x => re.test(norm(x)))
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__paramRun = () => window.__paramFooter(/执行|run/i)
  window.__paramCancel = () => window.__paramFooter(/取消|cancel/i)
  window.__paramHint = () => {
    const r = window.__paramRoot()
    const h = r && r.querySelector('.db-params-hint')
    return h ? h.innerText.trim() : null
  }
  window.__paramTitle = () => {
    const r = window.__paramRoot()
    const box = r && (r.closest('.ant-modal-container') || document)
    const t = box && box.querySelector('.ant-modal-title')
    return t ? t.innerText.trim() : null
  }
  window.__paramColor = sel => {
    const r = window.__paramRoot()
    const el = r && r.querySelector(sel)
    return el ? getComputedStyle(el).color : null
  }
  window.__colHashes = label => {
    const idx = window.__colIdx(label)
    if (idx < 0) return []
    return window.__rows().map(r => window.djb2(String((r.children[idx] || {}).innerText || '').trim()))
  }
  window.__cellText = (label, rowIdx) => {
    const idx = window.__colIdx(label)
    const rows = window.__rows()
    if (idx < 0 || !rows[rowIdx]) return null
    return String(rows[rowIdx].children[idx].innerText || '').trim()
  }
  window.__edXY = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)
    if (!ed) return JSON.stringify({ error: 'no-editor' })
    const r = ed.getBoundingClientRect()
    if (!r.width || !r.height) return JSON.stringify({ error: 'zero-rect' })
    return JSON.stringify({
      x: Math.round(r.left + 40),
      y: Math.round(r.top + 20),
      w: Math.round(r.width),
      h: Math.round(r.height)
    })
  }
  window.__statusLine = () => {
    const el = window.__one('.db-sql-elapsed') || window.__one('.db-grid-status')
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  }
  window.__alerts = () => JSON.stringify({
    alerts: [...document.querySelectorAll('.ant-alert-message')].filter(window.__vis)
      .map(x => x.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 2),
    connErr: [...document.querySelectorAll('.db-session-error')].filter(window.__vis)
      .map(x => x.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 1)
  })
  // 历史在主进程文件里。判据只回布尔与计数：语句原文不进 node 日志
  // need=最新一条原文里应当出现的参数名；newestOnly=最新一条里不该出现的值；
  // anywhere=整个 mysql 历史里都不该出现的值（只放"绝不可能是 SQL 字面量"的注入串：
  // level 的真值 'general' 这类词本来就可能被人敲进某条历史里，拿它扫全量只会假红）
  // 存储是 MRU（最新在前）且按归一化 SQL 去重：同一条再执行一次不增行，只挪到最前
  window.__histCheck = async (need, newestOnly, anywhere) => {
    try {
      const list = await window.pre.runGlobalAsync('dbSqlHistoryOp', 'list')
      const mine = (Array.isArray(list) ? list : []).filter(x => String(x.dbType) === 'mysql')
      const last = mine[0]
      if (!last) {
        return { n: 0, has: false, noQuestion: false, cleanNewest: false, badAnywhere: [-1], okFlag: null }
      }
      const sql = String(last.sql || '')
      const all = mine.map(x => String((x && x.sql) || '')).join('\\n')
      const badAnywhere = []
      ;(anywhere || []).forEach((v, i) => {
        if (all.indexOf(String(v)) >= 0) badAnywhere.push(i)
      })
      return {
        n: mine.length,
        has: (need || []).every(v => sql.indexOf(String(v)) >= 0),
        noQuestion: sql.indexOf('?') < 0,
        cleanNewest: (newestOnly || []).every(v => sql.indexOf(String(v)) < 0),
        badAnywhere,
        okFlag: !!last.ok
      }
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  }
  return 'probes-extra'
})()
`

const restoreAll = async () => {
  const cdp = cdpRef
  if (!cdp) {
    return
  }
  try {
    await cdp.eval('window.__spyRestore()')
    for (const id of openedTabs) {
      await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
    }
    if (cfg0.theme) {
      await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    }
    if (cfg0.locale) {
      await cdp.eval('window.store.setConfig({ dbFormatLocale: ' + JSON.stringify(cfg0.locale) + ' })')
    }
    await cdp.eval('window.__setLs(' + JSON.stringify(cfg0.split) + ')')
    console.log('restored: tabs=' + openedTabs.length + ' theme=' + cfg0.theme)
  } catch (e) {
    console.log('restore failed (theme/dbFormatLocale/' + SPLIT_KEY + ' 需手工确认): ' + e.message)
  }
  try {
    if (conn) {
      await conn.end()
    }
  } catch (e) { /* 参照连接断开失败不影响结论 */ }
}

const setSql = async (cdp, sql) => {
  const safe = assertSelectOnly(sql)
  // 先看程序化 focus 能不能落地；无头实例的窗口常常没有 OS 焦点，
  // .focus() 不移动 activeElement —— 那时改用真鼠标点进编辑器
  let st = await cdp.eval('window.__focusSql()')
  let how = 'focus()'
  if (st !== 'focused') {
    const xy = await cdp.jeval('window.__edXY()')
    if (xy.error) {
      return { ok: false, why: 'edXY:' + xy.error }
    }
    await cdp.click(xy.x, xy.y)
    await sleep(260)
    st = await cdp.eval('window.__focusSql()')
    how = 'click'
  }
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    commands: ['selectAll']
  })
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  })
  await cdp.call('Input.insertText', { text: safe })
  await sleep(250)
  const doc = String(await cdp.eval('window.__sqlDoc()'))
  return { ok: doc.indexOf(safe.slice(0, 40)) === 0, doc, how }
}

const park = async () => {
  await cdpRef.move(1560, 940)
  await sleep(120)
}

// 真键盘敲进参数输入框：React 受控值只能由真事件驱动
const fillParam = async (cdp, i, text) => {
  const xy = JSON.parse(await cdp.eval('window.__paramXY(' + i + ')'))
  if (xy.error) {
    return 'xy:' + xy.error
  }
  await cdp.click(xy.x, xy.y)
  await sleep(200)
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    commands: ['selectAll']
  })
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  })
  await cdp.call('Input.insertText', { text })
  await sleep(220)
  await park()
  const rows = await cdp.jeval('JSON.stringify(window.__paramRows())')
  return rows[i] && rows[i].vh === djb2(text) ? 'ok' : 'mismatch'
}

const clickNullBox = async (cdp, i) => {
  const xy = JSON.parse(await cdp.eval('window.__paramXY(' + i + ', "null")'))
  if (xy.error) {
    return 'xy:' + xy.error
  }
  await cdp.click(xy.x, xy.y)
  await sleep(240)
  await park()
  return 'ok'
}

// 面板初值来自上一轮的 memo（可能带着 isNull=true），所以每个槽位都先归一
const setSlot = async (cdp, i, v) => {
  const rows = await cdp.jeval('JSON.stringify(window.__paramRows())')
  const cur = rows[i] || {}
  if (v === null) {
    if (cur.nullChecked !== true) {
      const c = await clickNullBox(cdp, i)
      if (c !== 'ok') return c
    }
    return 'ok'
  }
  if (cur.nullChecked === true) {
    const c = await clickNullBox(cdp, i)
    if (c !== 'ok') return c
  }
  return fillParam(cdp, i, v)
}

// 打 SQL → 点执行 → 等面板弹出（此时一个请求都不该发）
const openModal = async (cdp, sql) => {
  const before = Number(await cdp.eval('window.__spyN()'))
  const set = await setSql(cdp, sql)
  if (!set.ok) {
    return { ok: false, stage: 'set', set, before }
  }
  await cdp.eval('window.__clickRunSql()')
  const open = await waitFor(cdp, 'window.__paramOpen()', 'params modal open', 8000)
  const rows0 = await cdp.jeval('JSON.stringify(window.__paramRows())')
  const spyAtOpen = Number(await cdp.eval('window.__spyN()'))
  if (!open) {
    return { ok: false, stage: 'open', set, before, rows0, spyAtOpen }
  }
  return { ok: true, stage: 'opened', before, rows0, spyAtOpen }
}

const fillSlots = async (cdp, values) => {
  for (let i = 0; i < values.length; i++) {
    const f = await setSlot(cdp, i, values[i])
    if (f !== 'ok') {
      return { ok: false, stage: 'fill' + i, f }
    }
  }
  return { ok: true }
}

// 提交 → 等真 executeSql 落定（用透传探针的 done 标记，不猜 DOM 的 loading）
const submitModal = async (cdp, before) => {
  const clicked = await cdp.eval('window.__paramRun()')
  await waitFor(cdp, '!window.__paramOpen()', 'modal closed', 6000)
  const settled = await waitFor(cdp, 'window.__spySettled()', 'real executeSql settled', 90000)
  await sleep(600)
  const last = await spyLast(cdp)
  return { ok: clicked === 'ok' && settled, clicked, settled, last, before, stage: 'done' }
}

const cancelModal = async cdp => {
  await cdp.eval('window.__paramCancel()')
  return waitFor(cdp, '!window.__paramOpen()', 'modal closed', 6000)
}

const runWithParams = async (cdp, sql, values, opt = {}) => {
  const opened = await openModal(cdp, sql)
  if (!opened.ok) {
    return opened
  }
  const filled = await fillSlots(cdp, values)
  if (!filled.ok) {
    return { ...opened, ...filled }
  }
  if (opt.submit === false) {
    return { ...opened, ...filled, stage: 'filled' }
  }
  return { ...opened, ...filled, ...(await submitModal(cdp, opened.before)) }
}

const spyLast = async cdp => cdp.jeval('window.__spyLast()')
const alerts = async cdp => cdp.jeval('window.__alerts()')
const colHashes = async (cdp, label) => cdp.jeval('JSON.stringify(window.__colHashes(' + JSON.stringify(label) + '))')

const finish = async () => {
  const bad = results.filter(r => !r.ok)
  const skipped = results.filter(r => r.skipped)
  console.log('\n' + (results.length - bad.length - skipped.length) + '/' +
    results.length + ' PASS（跳过 ' + skipped.length + '）')
  for (const one of bad) {
    console.log('FAILED → ' + one.name + ' :: ' + JSON.stringify(one.detail))
  }
  return bad.length
}

const main = async () => {
  const targets = await getJson('http://127.0.0.1:' + PORT + '/json/list')
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('没有渲染进程目标；应用是否带 --remote-debugging-port=' + PORT + ' 启动？')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.ready
  // 同一台实例上跑过假库演示脚本：它们接管 window.pre.runGlobalAsync 且不还原，
  // 不重载就开真库页签，会把"连接中"永远挂在假桩上（本次实测踩过）
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(500)
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  const booted = await waitFor(cdp, '!!(window.store && window.pre && window.translate)',
    'renderer boot', 40000)
  await cdp.eval(HELPERS)
  const cleanCtx = await cdp.eval('(() => ({ ' +
    'fixture: typeof window.__fixture, exec: typeof window.__exec, ' +
    'spy: typeof window.__spy, hist: typeof window.__hist }))()')
  check(L.A0, booted && cleanCtx.fixture === 'undefined' && cleanCtx.exec === 'undefined' &&
    cleanCtx.spy === 'undefined' && cleanCtx.hist === 'undefined', { booted, cleanCtx })
  if (!booted) {
    throw new Error('渲染进程没起来，后续判据没有意义')
  }

  if (!ENV.host || !ENV.user) {
    for (const k of Object.keys(L)) {
      skip(L[k], '缺 RDB_MYSQL_* 环境变量：真库段整体跳过（不算通过）')
    }
    return finish()
  }

  let base
  try {
    base = await oracle('SELECT COUNT(*) AS n, MIN(id) AS mn, MAX(id) AS mx FROM ' + TABLE, [])
  } catch (e) {
    base = null
    console.log('真库预检失败：' + ((e && e.code) || (e && e.message)))
  }
  if (!base || base.n !== 1 || Number(base.cells[0][0]) < 1) {
    for (const k of Object.keys(L)) {
      skip(L[k], '真库不可达或样本表为空：逐条跳过（不算通过）')
    }
    return finish()
  }
  const mx = Number(base.cells[0][2])
  const mn = Number(base.cells[0][1])
  const from = String(Math.max(mn, mx - WINDOW))
  const lvRows = await (async () => {
    const c = await connect()
    const [r] = await c.query('SELECT level, operate_type FROM ' + TABLE +
      ' WHERE id > ? ORDER BY id DESC LIMIT 1', [from])
    return r
  })()
  const LEVEL = String(lvRows[0].level)
  const OPTYPE = String(lvRows[0].operate_type)

  await cdp.eval(HELPERS_EXTRA)

  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  cfg0.locale = await cdp.eval('String((window.store._config || {}).dbFormatLocale)')
  const ls0 = await cdp.eval('window.__ls()')
  cfg0.split = ls0 === 'null' ? null : ls0

  const tabsCleared = await clearDbTabs(cdp)
  if (tabsCleared.left.length) {
    console.log('WARN 仍有未关掉的数据库页签：' + JSON.stringify(tabsCleared.left))
  }
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect',
      title: 'params realdb',
      dbType: 'mysql', dbHost: ${JSON.stringify(ENV.host)}, dbPort: Number(${JSON.stringify(ENV.port)}),
      dbUser: ${JSON.stringify(ENV.user)}, dbPassword: ${JSON.stringify(ENV.pass)},
      dbName: ${JSON.stringify(ENV.db)}, dbSsl: false,
      readOnly: true, production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  openedTabs.push(await cdp.eval('String(window.store.activeTabId)'))
  const treeShown = await waitFor(cdp,
    '!!window.__one(".db-tree") || !!window.__one(".db-session-error")', 'tree or conn error', 60000)
  const treeText = String(await cdp.eval('String(((window.__one(".db-tree") || { innerText: "" })).innerText)'))
  const err0 = await alerts(cdp)
  check(L.A1, treeShown && treeText.indexOf(ENV.db) >= 0 && !err0.connErr.length,
    { treeShown, hasDb: treeText.indexOf(ENV.db) >= 0, err: (err0.connErr || [])[0] || '' })

  await cdp.eval('window.__clickTreeExact(' + JSON.stringify(ENV.db) + ')')
  const tableShown = await waitFor(cdp, 'window.__hasTree(' + JSON.stringify(TABLE) + ')',
    'table node', 40000)
  const tableNode = await cdp.eval('window.__clickTree(' + JSON.stringify(TABLE) + ')')
  await sleep(800)
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(600)
  const spy = await cdp.eval('window.__spyInstall()')
  // 无头实例的窗口常常没有 OS 焦点，__focusSql() 的 .focus() 不移动 activeElement；
  // A2 只要求"编辑器在屏上、点得到"，真聚焦交给 setSql 里的鼠标兜底
  const hasEditor = await waitFor(cdp,
    '(() => { const r = JSON.parse(window.__edXY()); return r.x > 0 })()', 'sql editor clickable', 15000)
  check(L.A2, tableShown && tableNode === 'ok' && spy === 'ok' && hasEditor,
    { tableShown, tableNode, spy, hasEditor })

  const btnText = String(await cdp.eval(
    '(() => { const b = window.__paramBtn(); return b ? b.innerText.replace(/\\s/g, "") : "missing" })()'))
  const modeOn = await cdp.eval('window.__paramModeOn()')
  check(L.A3, /^(参数|params)$/i.test(btnText) && modeOn === true, { btnText, modeOn })

  // ── B) 两个参数：先弹面板 → 收值 → 绑定 → 真结果与参照一致 ──────
  const orTwo = await oracle(PH_TWO, [LEVEL, from])
  const preB = await runWithParams(cdp, SQL_TWO, [LEVEL, from], { submit: false })
  const rows0 = preB.rows0 || []
  check(L.B1, preB.stage === 'filled' && preB.spyAtOpen === preB.before &&
    rows0.length === 2 && rows0.every(r => r.empty === true && r.nullChecked === false && r.disabled === false),
  { stage: preB.stage, spyAtOpen: preB.spyAtOpen, before: preB.before, rows0: rows0.map(r => ({ n: r.name, e: r.empty })), why: preB.set || preB.f })
  const rows1 = await cdp.jeval('JSON.stringify(window.__paramRows())')
  check(L.B2, rows1.length === 2 && rows1[0].name === ':lv' && rows1[1].name === ':from' &&
    rows1.every(r => r.nullChecked === false && r.disabled === false) &&
    rows1[0].vh === djb2(LEVEL) && rows1[1].vh === djb2(from),
  rows1.map(r => ({ n: r.name, filled: r.vh === djb2(LEVEL) || r.vh === djb2(from), nu: r.nullChecked, d: r.disabled })))
  const hint = String(await cdp.eval('window.__paramHint()'))
  const title = String(await cdp.eval('window.__paramTitle()'))
  check(L.B3, /参数|parameter/i.test(hint) && /绑定|bind/i.test(hint) &&
    !/\{[a-z]+\}/i.test(hint) && !!title && !/\{/.test(title),
  { hint: hint.slice(0, 48), title: title.slice(0, 24) })

  const subB = await submitModal(cdp, preB.before)
  const lastB = subB.last
  const hashesB = await colHashes(cdp, 'id')
  const headsB = await cdp.jeval('window.__headerLabels()')
  const alertsB = await alerts(cdp)
  check(L.B4, subB.clicked === 'ok' && lastB.sql === PH_TWO && lastB.sql.indexOf(':lv') < 0,
    { clicked: subB.clicked, same: lastB.sql === PH_TWO, got: String(lastB.sql).slice(0, 60) })
  check(L.B5, lastB.pn === 2 && lastB.sql.indexOf(LEVEL) < 0 && lastB.sql.indexOf(from) < 0 &&
    String(lastB.db) === ENV.db, pick(lastB, ['pn', 'db']))
  check(L.B6, subB.ok && lastB.err === 0 && hashesB.length === orTwo.n &&
    String(headsB[0]) === 'id' && alertsB.alerts.length === 0,
  { ok: subB.ok, err: lastB.err, n: hashesB.length, oracleN: orTwo.n, heads: headsB.slice(0, 6), alerts: alertsB.alerts })
  check(L.B7, hashesB.length === 5 && hashesB.join(',') === orTwo.idHashes.join(','),
    { n: hashesB.length, same: hashesB.join(',') === orTwo.idHashes.join(',') })
  const statusTxt = String(await cdp.eval('window.__statusLine()'))
  check(L.B8, Number(lastB.ms) > 0 && /\d+\s*(ms|毫秒)|\d+(\.\d+)?\s*(s|秒)/i.test(statusTxt),
    { ms: lastB.ms, status: statusTxt.slice(0, 70) })

  // ── C) 同名参数只问一次；字符串字面量里的 :zzz 不算参数 ─────────
  // 窗口边界用字面数字（不是参数）：让这一组只考察"同名/字面量"这一条语义
  const SQL_SAME = "SELECT 'literal :zzz' AS lit, id FROM " + TABLE +
    ' WHERE level = :lv AND operate_type <> :lv AND id > ' + from + ' ORDER BY id DESC LIMIT 3'
  const PH_SAME = "SELECT 'literal :zzz' AS lit, id FROM " + TABLE +
    ' WHERE level = ? AND operate_type <> ? AND id > ' + from + ' ORDER BY id DESC LIMIT 3'
  const orSame = await oracle(PH_SAME, [LEVEL, LEVEL])
  const openC = await openModal(cdp, SQL_SAME)
  const fillC = await fillSlots(cdp, [LEVEL])
  const rowsC = await cdp.jeval('JSON.stringify(window.__paramRows())')
  const subC = await submitModal(cdp, openC.before)
  const hashesC = await colHashes(cdp, 'id')
  check(L.C1, openC.ok && fillC.ok && subC.ok && rowsC.length === 1 && rowsC[0].name === ':lv' &&
    subC.last.sql === PH_SAME && subC.last.pn === 2 && subC.last.sql.indexOf(':zzz') >= 0,
  { rows: rowsC.map(r => r.name), sqlSame: subC.last.sql === PH_SAME, pn: subC.last.pn, litKept: String(subC.last.sql).indexOf(':zzz') >= 0 })
  check(L.C2, orSame.n > 0 && hashesC.length === orSame.n &&
    hashesC.join(',') === orSame.idHashes.join(','),
  { n: hashesC.length, oracleN: orSame.n, same: hashesC.join(',') === orSame.idHashes.join(',') })

  // ── D) 注入与转义：只有真服务端能给答案 ─────────────────────────
  const orInjA = await oracle(PH_TYPE, [INJ_A, from])
  const d1 = await runWithParams(cdp, SQL_TYPE, [INJ_A, from])
  const hashesD1 = await colHashes(cdp, 'id')
  const alertsD1 = await alerts(cdp)
  check(L.D1, d1.ok && d1.last.err === 0 && orInjA.n === 0 && hashesD1.length === 0 &&
    alertsD1.alerts.length === 0,
  { oracleN: orInjA.n, gotN: hashesD1.length, err: d1.last.err, alerts: alertsD1.alerts.map(a => a.slice(0, 40)) })

  const orInjB = await oracle(PH_TYPE, [INJ_B, from])
  const d2 = await runWithParams(cdp, SQL_TYPE, [INJ_B, from])
  const hashesD2 = await colHashes(cdp, 'id')
  const alertsD2 = await alerts(cdp)
  check(L.D2, d2.ok && d2.last.err === 0 && orInjB.n === 0 && hashesD2.length === 0 &&
    alertsD2.alerts.length === 0,
  { oracleN: orInjB.n, gotN: hashesD2.length, err: d2.last.err, alerts: alertsD2.alerts.map(a => a.slice(0, 40)) })

  const orPos = await oracle(PH_TYPE, [OPTYPE, from])
  const d3 = await runWithParams(cdp, SQL_TYPE, [OPTYPE, from])
  const hashesD3 = await colHashes(cdp, 'id')
  check(L.D3, d3.ok && orPos.n > 0 && hashesD3.length === orPos.n &&
    hashesD3.join(',') === orPos.idHashes.join(','),
  { oracleN: orPos.n, gotN: hashesD3.length, same: hashesD3.join(',') === orPos.idHashes.join(',') })
  await cdp.shot(path.join(SHOT_DIR, '1-dark-params-result.png'))

  const orEsc = await oracle(PH_ESC, [BACKSLASH, BACKSLASH])
  const d4 = await runWithParams(cdp, SQL_ESC, [BACKSLASH])
  const klen = String(await cdp.eval('window.__cellText("klen", 0)'))
  const isEq = String(await cdp.eval('window.__cellText("is_eq", 0)'))
  check(L.D4, d4.ok && klen === '3' && isEq === '1' && orEsc.cells.length === 1 &&
    klen === orEsc.cells[0][0] && isEq === orEsc.cells[0][1],
  { oracle: orEsc.cells[0], klen, isEq })

  // ── E) NULL：勾上发的是真 null，不是空串 ────────────────────────
  const openE = await openModal(cdp, SQL_NULL)
  const fillE = await fillSlots(cdp, [null])
  const rowsE = await cdp.jeval('JSON.stringify(window.__paramRows())')
  check(L.E1, openE.ok && fillE.ok && rowsE.length === 1 &&
    rowsE[0].nullChecked === true && rowsE[0].disabled === true, { rowsE, fillE })
  const subE = await submitModal(cdp, openE.before)
  const isNull1 = String(await cdp.eval('window.__cellText("is_null", 0)'))
  check(L.E2, subE.ok && subE.last.sql === PH_NULL && subE.last.pn === 2 &&
    subE.last.hasNull === true && isNull1 === '1',
  { ok: subE.ok, sqlSame: subE.last.sql === PH_NULL, pn: subE.last.pn, hasNull: subE.last.hasNull, isNull1 })
  const e2 = await runWithParams(cdp, SQL_NULL, [''])
  const isNull2 = String(await cdp.eval('window.__cellText("is_null", 0)'))
  const isEmpty2 = String(await cdp.eval('window.__cellText("is_empty", 0)'))
  check(L.E3, e2.ok && e2.last.hasNull === false && isNull2 === '0' && isEmpty2 === '1',
    { hasNull: e2.last.hasNull, isNull2, isEmpty2 })

  // ── F) 历史与"记住本次值"、取消零执行 ───────────────────────────
  const histCheck = (need, forbid) => cdp.eval(
    'window.__histCheck(' + JSON.stringify(need) + ', ' + JSON.stringify(forbid) + ')')
  const histBefore = await histCheck([], [], [])
  const fRun = await runWithParams(cdp, SQL_TWO, [LEVEL, from])
  await sleep(700)
  // 全量扫描只放注入串：from 那个 id 下界在 C 段是以字面量写进 SQL_SAME 的，
  // 出现在历史里是正常的，混进 forbid 只会造成假红
  const histAfter = await histCheck([':lv', ':from'], [LEVEL, from], [INJ_A, INJ_B, BACKSLASH])
  check(L.F1, fRun.ok && histAfter.n === histBefore.n && histAfter.has === true &&
    histAfter.noQuestion === true && histAfter.cleanNewest === true &&
    histAfter.badAnywhere.length === 0 && histAfter.okFlag === true,
  pick(histAfter, ['n', 'has', 'noQuestion', 'cleanNewest', 'badAnywhere', 'okFlag']))

  const openF = await openModal(cdp, SQL_TWO)
  check(L.F2, openF.ok && openF.rows0.length === 2 &&
    openF.rows0[0].vh === djb2(LEVEL) && openF.rows0[1].vh === djb2(from),
  (openF.rows0 || []).map(r => ({ n: r.name, kept: r.vh === djb2(LEVEL) || r.vh === djb2(from) })))
  await cancelModal(cdp)
  const nBefore = Number(await cdp.eval('window.__spyN()'))
  const hashBefore = await cdp.eval('window.__colHashes("id").join(",")')
  const openF2 = await openModal(cdp, SQL_TWO)
  await cancelModal(cdp)
  await sleep(500)
  const nAfter = Number(await cdp.eval('window.__spyN()'))
  const hashAfter = await cdp.eval('window.__colHashes("id").join(",")')
  check(L.F3, openF2.ok && nAfter === nBefore && String(hashAfter) === String(hashBefore) &&
    String(hashAfter) !== '',
  { nBefore, nAfter, same: String(hashAfter) === String(hashBefore), nonEmpty: String(hashAfter) !== '' })

  // ── G) 浅色主题：面板颜色跟 token 走（真库页签上再看一次） ──────
  const openG = await openModal(cdp, SQL_TWO)
  await fillSlots(cdp, [LEVEL, from])
  const darkName = String(await cdp.eval('window.__paramColor(".db-params-name")'))
  const darkHint = String(await cdp.eval('window.__paramColor(".db-params-hint")'))
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0.theme)
  check(L.G0, openG.ok && !!darkName && !!darkHint, { ok: openG.ok, darkName, darkHint })
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1300)
    const lightName = String(await cdp.eval('window.__paramColor(".db-params-name")'))
    const lightHint = String(await cdp.eval('window.__paramColor(".db-params-hint")'))
    check(L.G1, !!lightName && lightName !== darkName && lightHint !== darkHint,
      { darkName, lightName, darkHint, lightHint })
    await cdp.shot(path.join(SHOT_DIR, '2-light-params-modal.png'))
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    await sleep(600)
  } else {
    skip(L.G1, 'terminalThemes 里没有浅色主题')
  }
  await cancelModal(cdp)
  await sleep(300)
  return finish()
}

const bail = async code => {
  await restoreAll()
  process.exit(code)
}

main().then(f => bail(f ? 1 : 0), e => {
  console.error(e)
  return bail(1)
})
