#!/usr/bin/env node
/**
 * N3a 结构对比 → 候选 DDL —— CDP 实机验收
 *
 * 生成算法由 src/test/unit-ci/db-ddl-generate.spec.js 逐字钉死（48 条），这里只钉
 * "接到界面之后才会坏"的事：
 *   1) 勾选以差异条目为单位：勾 2 条得到那 2 条的全部语句（PG 一条差异可能出 2 句）；
 *   2) 生成不了的条目（白名单外类型 / 外键 / 索引变化 / :: 默认值）灰掉，且写明原因
 *      —— 用户必须能看出"为什么这里没有勾"，而不是以为功能坏了；
 *   3) 全选三态（未选 / 部分 / 全选）与"没勾选就没有按钮"；
 *   4) 语句落到 SQL 编辑器：文字进去、位置对（不吞用户已写的东西），
 *      并且**全程零执行** —— ops 里不出现 executeSql（这是 N3a 的安全边界）；
 *   5) 方言分流：同一个差异形状，MySQL 出 ALTER TABLE ... MODIFY / ADD INDEX，
 *      PG 出 ALTER COLUMN TYPE / CREATE INDEX / COMMENT ON COLUMN —— 语法不能串门；
 *   6) 换一对表 → 勾选作废（上一对的语句不能落进这一对的表）；
 *   7) 真库腿（node:sqlite 文件）：SQLite 一条都不生成，只报差异；
 *   8) 双主题：语句预览与说明条颜色跟着 token 走。
 *
 * 腿的顺序固定：真库腿在前。桩腿会整体替换 window.pre.runGlobalAsync 且不还原
 * （沿用本仓库自测的既有做法），先跑真的才不被污染。
 *
 * 用法：
 *   1) npm run compile && rsync -a src/app/ work/app/   # 词条在主进程侧
 *   2) DISPLAY=:139 HOME=/tmp/electerm-n3a/home TMPDIR=/tmp/electerm-n3a/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9389 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-structure-ddl-demo.js [debugPort] [shotDir]
 *
 * 夹具在 /tmp/electerm-n3a/demo 下、每次重建：本机假数据，截图可进仓库。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9389'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-structure-ddl-shots')
const DEMO_DIR = '/tmp/electerm-n3a/demo'
const DB = path.join(DEMO_DIR, 'ddl.db')
const { results, check } = makeChecker()
const J = s => JSON.stringify(s)

// ── 页内探针 ────────────────────────────────────────────────────────
const HELPERS = `(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__one = sel => [...document.querySelectorAll(sel)].filter(window.__vis)[0] || null
  window.__xy = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__diffBtn = () => [...document.querySelectorAll('.db-struct-tools button')]
    .filter(window.__vis).find(b => /结构对比|Compare structure/i.test(b.innerText)) || null
  window.__diffRoot = () => window.__one('.db-diff')
  window.__diffOpen = () => !!window.__diffRoot()
  window.__diffSels = () => {
    const r = window.__diffRoot()
    return r ? [...r.querySelectorAll('.db-diff-select')] : []
  }
  window.__diffSelTexts = () => window.__diffSels().map(s => {
    const t = s.querySelector('.ant-select-content')
    if (!t || !t.classList.contains('ant-select-content-has-value')) return ''
    return (t.getAttribute('title') || t.innerText || '').trim()
  })
  window.__diffSelXY = i => window.__xy(window.__diffSels()[i])
  window.__diffOptions = () => [...document.querySelectorAll('.ant-select-item-option')]
    .filter(window.__vis).map(o => o.innerText.trim())
  // 库名前缀各引擎不同（mysql 是 demo.t，sqlite 可能是 main.t），按"包含表名"点
  window.__diffOptXY = suffix => {
    const o = [...document.querySelectorAll('.ant-select-item-option')]
      .filter(window.__vis).find(x => x.innerText.trim().endsWith(suffix))
    return window.__xy(o)
  }
  window.__diffRows = () => {
    const r = window.__diffRoot()
    if (!r) return []
    return [...r.querySelectorAll('.db-diff-row')].map(row => {
      const cb = row.querySelector('.db-diff-checkbox')
      const input = cb ? cb.querySelector('input') : null
      return {
        name: (row.querySelector('.db-diff-name') || {}).innerText || '',
        checked: !!(input && input.checked),
        disabled: !!(input && input.disabled),
        sqls: [...row.querySelectorAll('.db-diff-ddl-sql')].map(x => x.innerText.trim()),
        reason: ((row.querySelector('.db-diff-ddl-reason') || {}).innerText || '').trim() || null,
        xy: window.__xy(cb)
      }
    })
  }
  window.__diffRow = name => window.__diffRows().find(r => String(r.name).trim() === name) || null
  window.__ddlBar = () => {
    const r = window.__diffRoot()
    const bar = r ? r.querySelector('.db-diff-ddl-bar') : null
    if (!bar) return null
    const input = bar.querySelector('.db-diff-ddl-all input')
    const btn = bar.querySelector('button')
    return {
      tip: ((bar.querySelector('.db-diff-ddl-tip') || {}).innerText || '').trim(),
      why: ((bar.querySelector('.db-diff-ddl-why') || {}).innerText || '').trim() || null,
      allChecked: !!(input && input.checked),
      allIndeterminate: !!(input && input.indeterminate),
      allDisabled: !!(input && input.disabled),
      btnDisabled: !!(btn && btn.disabled),
      btnText: btn ? btn.innerText.trim() : null,
      btnXY: window.__xy(btn),
      allXY: window.__xy(bar.querySelector('.db-diff-ddl-all'))
    }
  }
  window.__diffClose = () => {
    const r = window.__diffRoot()
    if (!r) return 'no-root'
    const box = r.closest('.ant-modal-container')
    const b = [...box.querySelectorAll('.ant-modal-footer button')].find(x =>
      /关闭|close/i.test(String(x.innerText).split(' ').join('')))
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__openSqlPage = () => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis)
      .find(x => /SQL/i.test(x.innerText))
    if (!t) return 'missing'
    t.click()
    return 'ok'
  }
  window.__sqlText = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    return ed ? ed.innerText : null
  }
  window.__diffHint = () => {
    const r = window.__diffRoot()
    return r ? [...r.querySelectorAll('.db-diff-hint')].map(x => x.innerText.trim()).filter(Boolean) : []
  }
  window.__color = sel => {
    const el = window.__one(sel)
    return el ? getComputedStyle(el).color : null
  }
  window.__errs = []
  window.addEventListener('error', ev => {
    window.__errs.push(String((ev.error && ev.error.stack) || ev.message || '').split('\\n').slice(0, 3).join(' | '))
  })
  window.addEventListener('unhandledrejection', ev => {
    window.__errs.push('REJ ' + String((ev.reason && ev.reason.stack) || ev.reason || '').split('\\n').slice(0, 3).join(' | '))
  })
  return 'probes-ready'
})()`

// ── 真库腿：node:sqlite 文件，两张结构不同的表 ──────────────────────
const buildRealDb = () => {
  fs.rmSync(DEMO_DIR, { recursive: true, force: true })
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  const db = new DatabaseSync(DB)
  db.exec(`
    CREATE TABLE t_base (
      id integer primary key,
      note text not null default 'x',
      legacy text,
      amount real,
      photo blob
    );
    CREATE INDEX idx_legacy ON t_base (legacy);
    CREATE TABLE t_new (
      id integer primary key,
      note text not null default 'y',
      extra text,
      amount real
    );
    CREATE INDEX idx_extra ON t_new (extra);
  `)
  db.close()
}

const openTab = async (cdp, opts) => cdp.eval(`(() => {
  window.store.addTab(Object.assign({
    type: 'database',
    from: 'quick-connect',
    batch: window.store.currentLayoutBatch
  }, ${J(opts)}))
  const t = window.store.tabs[window.store.tabs.length - 1]
  window.store.changeActiveTabId(t.id)
  return t.id
})()`)

const STRUCTURES = `
(() => {
  const col = (name, extra) => Object.assign({
    name, dataType: 'int', columnType: 'int(11)', nullable: false, defaultValue: null,
    isPrimaryKey: false, ordinal: 1, comment: null, maxLength: null
  }, extra || {})
  const idx = (name, columns, extra) => Object.assign({
    name, unique: false, primary: false, columns, method: 'BTREE'
  }, extra || {})
  const fk = (name, columns, refTable, refColumns, extra) => Object.assign({
    name, columns, refSchema: null, refTable, refColumns, onDelete: 'RESTRICT', onUpdate: 'NO ACTION'
  }, extra || {})
  // A（基准）与 B（对比）：每条差异只碰一件事，界面上要能一对一指认
  const S = {
    t_a: {
      type: 'table',
      columns: [
        col('id', { isPrimaryKey: true }),
        col('legacy', { columnType: 'varchar(32)', dataType: 'varchar', maxLength: 32, nullable: true }),
        col('status', { columnType: 'varchar(16)', dataType: 'varchar', maxLength: 16, defaultValue: 'new' }),
        col('amount', { columnType: 'decimal(10,2)', dataType: 'decimal' }),
        col('keep_me')
      ],
      indexes: [
        idx('PRIMARY', ['id'], { unique: true, primary: true }),
        idx('idx_legacy', ['legacy'])
      ],
      foreignKeys: []
    },
    t_b: {
      type: 'table',
      columns: [
        col('id', { isPrimaryKey: true }),
        col('note', { columnType: 'varchar(64)', dataType: 'varchar', maxLength: 64, nullable: true, comment: '备注' }),
        col('photo', { columnType: 'blob', dataType: 'blob', nullable: true }),
        col('status', { columnType: 'varchar(16)', dataType: 'varchar', maxLength: 16, defaultValue: 'paid' }),
        col('amount', { columnType: 'decimal(12,2)', dataType: 'decimal' }),
        col('ratios', { columnType: 'numeric(4,2)', dataType: 'numeric', nullable: true, defaultValue: '0.00::numeric' }),
        col('keep_me')
      ],
      indexes: [
        idx('PRIMARY', ['id'], { unique: true, primary: true }),
        idx('idx_note', ['note']),
        idx('idx_amount', ['amount'])
      ],
      foreignKeys: [fk('fk_note_ref', ['note'], 't_ref', ['note'])]
    }
  }
  window.__dbStub = 'n3a'
  window.__ops = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      window.__ops.push(op)
      if (op === 'getTableStructure') {
        const hit = S[(a[2] || {}).table]
        return hit ? Promise.resolve(JSON.parse(JSON.stringify(hit))) : Promise.reject(new Error('no table'))
      }
      if (op === 'getMetadata') {
        const leaves = [{ name: 't_a', type: 'table' }, { name: 't_b', type: 'table' }]
        // pg 的 metadata 带 schema 层，正好让生成的语句走 schema.table 那一支
        const children = window.__stubShape === 'pg'
          ? [{ name: 'public', type: 'schema', children: leaves }]
          : leaves
        return Promise.resolve([{ name: 'demo', type: 'database', children }])
      }
      if (op === 'listColumns') return Promise.resolve([{ name: 'id', type: 'int' }])
      if (op === 'describeTable') return Promise.resolve([{ Field: 'id', Type: 'int' }])
      if (op === 'getPageData') return Promise.resolve({ rows: [{ id: 1 }], totalRows: 1, hasMore: false })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    return Promise.resolve(null)
  }
  return 'stubbed'
})()`

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1500)
  await cdp.eval(HELPERS)
  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const f = path.join(SHOT_DIR, String(shotIdx) + '-' + name + '.png')
    await sleep(350)
    await cdp.shot(f)
    console.log('shot -> ' + path.basename(f))
  }
  await clearDbTabs(cdp)

  // CodeMirror / antd 会在汉字间插空格，比对前先折叠空白
  const norm = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim()
  // 零执行的判据：整个流程里没有任何"写/执行"类 op（只读的 getDbTxState、
  // getTableStructure 这类本来就会发，算进来是把噪音当违规）
  const writeOps = () => cdp.jeval(
    'JSON.stringify(window.__ops.filter(o => /executeSql|^updateCells?$|^insertRow$|^deleteRows$/.test(o)))')

  // 树上按名字点节点：库名/表名都可能出现 "main"、"ddl.db"、"demo.public.t_a" 这类
  // 带前缀的写法，所以整名或最后一段命中都算；节点是异步渲染的，等它出现再点。
  // schema 节点的 innerText 带徽标与子计数（实测 PG 树里是 "S\npublic\n2"），
  // 所以先折叠空白再按空格/点分段匹配，不然腿 3 会因为找不到 public 而 whole 挂掉。
  const treeDump = () => cdp.jeval(
    'JSON.stringify([...document.querySelectorAll(".ant-tree-title")]' +
    '.filter(window.__vis).map(x => x.innerText.trim()))')
  const expandCollapsed = async () => {
    for (let i = 0; i < 5; i++) {
      const sw = await cdp.eval(`(() => {
        const s = [...document.querySelectorAll('.db-tree .ant-tree-switcher_close')]
          .filter(window.__vis)[0]
        if (!s) return null
        const r = s.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`)
      if (!sw) return
      const p = JSON.parse(sw)
      await cdp.click(p.x, p.y)
      await sleep(900)
    }
  }
  const clickTree = async label => {
    for (let t = 0; t < 10; t++) {
      const hit = await cdp.eval(`(() => {
        const n = [...document.querySelectorAll('.ant-tree-title')]
          .filter(window.__vis).find(x => {
            const raw = String(x.innerText).trim()
            if (raw === ${J(label)}) return true
            return raw.split(/\\s+/).some(s => s.split('.').pop() === ${J(label)})
          })
        if (!n) return 'missing'
        n.click()
        return 'ok'
      })()`)
      if (hit === 'ok') {
        await sleep(1300)
        return 'ok'
      }
      await expandCollapsed()
      await sleep(500)
    }
    return 'missing:' + (await treeDump()).join('|')
  }
  const clickPageTab = async re => {
    const r = await cdp.eval(`(() => {
      const t = [...document.querySelectorAll('.ant-tabs-tab')]
        .filter(window.__vis).find(x => new RegExp(${J(re)}, 'i').test(String(x.innerText)))
      if (!t) return 'missing'
      t.click()
      return 'ok'
    })()`)
    await sleep(700)
    return r
  }

  // 树上一路点到 A 表 → 结构页 → 打开弹层 → B 选成 suffix 结尾那张表
  // （调用方已经 clearDbTabs 并开好页签，这里不能再清，否则把自己刚开的页签删了）
  const openDiff = async (treeLabels, suffixB) => {
    for (const l of treeLabels) {
      const r = await clickTree(l)
      if (r !== 'ok') return 'no-tree-node:' + l + '=' + r
    }
    if (await clickPageTab('表结构|Structure') !== 'ok') return 'no-struct-tab'
    if (!await cdp.eval('!!window.__diffBtn()')) return 'no-diff-button'
    await cdp.eval('window.__diffBtn().click()')
    if (!await waitFor(cdp, 'window.__diffOpen()', 'diff modal', 15000)) return 'modal-not-open'
    if (!suffixB) return 'ok'
    await sleep(400)
    return await pickTarget(suffixB)
  }
  // 把第二个下拉（B）选成以 suffix 结尾的候选
  const pickTarget = async suffix => {
    const xy = await cdp.jeval('JSON.stringify(window.__diffSelXY(1))')
    if (!xy) return 'no-select'
    await cdp.click(xy.x, xy.y)
    if (!await waitFor(cdp,
      `window.__diffOptions().some(o => o.endsWith(${J(suffix)}))`, 'options listed', 6000)) {
      return 'option-not-listed'
    }
    await sleep(420)
    const o = await cdp.jeval(`JSON.stringify(window.__diffOptXY(${J(suffix)}))`)
    if (!o) return 'no-option-rect'
    await cdp.click(o.x, o.y)
    return await waitFor(cdp,
      `(window.__diffSelTexts()[1] || '').endsWith(${J(suffix)})`, 'selection applied', 6000)
      ? 'ok'
      : 'not-applied'
  }

  // 一条差异行 → 结构化判据（能不能勾、勾上没有、语句长什么样、不给语句时写了什么）
  const rowState = async name => {
    const r = await cdp.jeval('JSON.stringify(window.__diffRow(' + J(name) + '))')
    if (!r) return null
    return {
      disabled: r.disabled,
      checked: r.checked,
      sqls: r.sqls.map(norm),
      reason: norm(r.reason)
    }
  }
  const clickRow = async name => {
    const r = await cdp.jeval('JSON.stringify(window.__diffRow(' + J(name) + '))')
    if (!r || !r.xy) return 'no-row'
    await cdp.click(r.xy.x, r.xy.y)
    await sleep(280)
    return 'ok'
  }
  const bar = () => cdp.jeval('JSON.stringify(window.__ddlBar())')
  const clickAll = async () => {
    const b = await bar()
    if (!b || !b.allXY) return 'no-all-box'
    await cdp.click(b.allXY.x, b.allXY.y)
    await sleep(300)
    return 'ok'
  }
  // 编辑器里先放用户自己写的一句：真鼠标点进编辑器 + Input.insertText，
  // 这是 CodeMirror 6 唯一认的写入路径（db-sql-ai-demo 钉过）；
  // 必须在打开弹层之前做 —— 弹层遮罩会挡住页签。
  const seedEditor = async text => {
    if (await clickPageTab('SQL') !== 'ok') return 'no-sql-tab'
    if (!await waitFor(cdp,
      "[...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis).length > 0",
      'sql editor visible', 10000)) {
      return 'no-editor'
    }
    let focused = false
    for (let t = 0; t < 4 && !focused; t++) {
      const p = await cdp.jeval(`(() => {
        const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
        if (!ed) return null
        const r = ed.getBoundingClientRect()
        return JSON.stringify({
          x: Math.round(r.left + Math.min(60, r.width / 2)),
          y: Math.round(r.top + Math.min(20, r.height / 2))
        })
      })()`)
      if (!p) return 'no-editor-rect'
      await cdp.move(p.x, p.y)
      await sleep(150)
      await cdp.click(p.x, p.y)
      await sleep(320)
      focused = await cdp.eval(
        "(() => { const ed = [...document.querySelectorAll('.db-sql-area .cm-content')]" +
        '.filter(window.__vis)[0]; return !!(ed && document.activeElement === ed) })()')
    }
    if (!focused) return 'editor-not-focused'
    await cdp.call('Input.insertText', { text })
    await sleep(400)
    return norm(await cdp.jeval('window.__sqlText()'))
  }
  const editorLines = async () => String(await cdp.jeval('window.__sqlText()') || '')
    .split('\n').map(norm).filter(Boolean)

  // ══ 腿 1：真 node:sqlite（桩会顶掉桥接函数，真库必须先跑）═══════════════
  buildRealDb()
  const sqliteTab = await openTab(cdp, {
    title: 'sqlite ' + path.basename(DB),
    dbType: 'sqlite',
    dbFile: DB,
    readOnly: false,
    production: false
  })
  const sqliteUp = await waitFor(cdp,
    `window.store.activeTabId === ${J(sqliteTab)}`, 'sqlite tab active', 30000) &&
    await waitFor(cdp,
      "[...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).length > 0",
      'sqlite tree', 30000)
  check('真库腿：SQLite 页签连上、树里出现库节点', sqliteUp, sqliteTab)

  const sOpen = await openDiff(['main', 't_base'], 't_new')
  check('真库腿：A 默认当前表 main.t_base、B 选到 t_new', sOpen === 'ok',
    { sOpen, sels: await cdp.jeval('JSON.stringify(window.__diffSelTexts())') })
  await waitFor(cdp, 'window.__diffRows().length > 0', 'sqlite rows', 15000)
  const sRows = (await cdp.jeval('JSON.stringify(window.__diffRows())')).map(r => ({
    n: norm(r.name), d: r.disabled, nsql: r.sqls.length, why: norm(r.reason)
  }))
  check('真库腿：SQLite 每条差异都灰掉、零语句、原因写明 ALTER 只有四形',
    sRows.length > 0 && sRows.every(r => r.d && r.nsql === 0 && /SQLite/i.test(r.why)), sRows)
  const sBar = await bar()
  check('真库腿：说明条=「没有可生成的语句」、无全选框、按钮禁用且 0 句',
    sBar && /没有可生成|Nothing to generate/i.test(sBar.tip) && sBar.allChecked === false &&
      sBar.btnDisabled === true && sBar.allXY === null && /0/.test(String(sBar.btnText)), sBar)
  await shot('sqlite-realdb-no-generation')
  check('真库腿：关闭弹层', await cdp.eval('window.__diffClose()') === 'ok')

  // ══ 腿 2：MySQL 桩（语法 / 勾选 / 落编辑器 / 全程零执行）════════════════
  await cdp.eval(STRUCTURES)
  await cdp.eval('window.__stubShape = "mysql"')
  const myTab = await openTab(cdp, {
    title: 'mysql root@127.0.0.1:3306/demo',
    dbType: 'mysql',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'root',
    dbPassword: '',
    dbName: 'demo',
    dbSsl: false,
    readOnly: true,
    production: false
  })
  await waitFor(cdp, `window.store.activeTabId === ${J(myTab)}`, 'mysql tab active', 20000)
  const seededM = await seedEditor('SELECT 1')
  check('MySQL 腿：先把用户手写语句放进编辑器', seededM === 'SELECT 1', seededM)
  const mOpen = await openDiff(['demo', 't_a'], 't_b')
  check('MySQL 腿：A=demo.t_a、B=demo.t_b 打开并出差异',
    mOpen === 'ok' &&
      (await cdp.jeval('JSON.stringify(window.__diffSelTexts())')).join(',') === 'demo.t_a,demo.t_b',
    { mOpen, sels: await cdp.jeval('JSON.stringify(window.__diffSelTexts())') })
  await waitFor(cdp, 'window.__diffRows().length >= 10', 'mysql rows', 15000)

  const legacy = await rowState('legacy')
  const noteM = await rowState('note')
  const amountM = await rowState('amount')
  const statusM = await rowState('status')
  const idxNoteM = await rowState('idx_note')
  const idxLegacyM = await rowState('idx_legacy')
  const photoM = await rowState('photo')
  const ratiosM = await rowState('ratios')
  const fkM = await rowState('fk_note_ref')
  check('MySQL：删列 → DROP COLUMN，定位取 A 表（反引号 demo.t_a）',
    !!legacy && legacy.disabled === false &&
      legacy.sqls.join(' ') === 'ALTER TABLE `demo`.`t_a` DROP COLUMN `legacy`', legacy)
  check('MySQL：加列 → 一条全定义 ADD COLUMN（注释内联，不另起 COMMENT ON）',
    !!noteM && noteM.sqls.length === 1 &&
      noteM.sqls[0] === "ALTER TABLE `demo`.`t_a` ADD COLUMN `note` varchar(64) COMMENT '备注'",
    noteM)
  check('MySQL：改类型 / 改默认 → MODIFY COLUMN 全定义重写',
    !!amountM && amountM.sqls[0] ===
      'ALTER TABLE `demo`.`t_a` MODIFY COLUMN `amount` decimal(12,2) NOT NULL' &&
    !!statusM && statusM.sqls[0] ===
      "ALTER TABLE `demo`.`t_a` MODIFY COLUMN `status` varchar(16) NOT NULL DEFAULT 'paid'",
    { amountM, statusM })
  check('MySQL：索引增 → ADD INDEX、索引删 → DROP INDEX',
    !!idxNoteM && idxNoteM.sqls[0] ===
      'ALTER TABLE `demo`.`t_a` ADD INDEX `idx_note` (`note`)' &&
    !!idxLegacyM && idxLegacyM.sqls[0] ===
      'ALTER TABLE `demo`.`t_a` DROP INDEX `idx_legacy`', { idxNoteM, idxLegacyM })
  check('MySQL：blob 灰掉并说明「类型不在白名单」',
    !!photoM && photoM.disabled === true && photoM.sqls.length === 0 &&
      /白名单|outside the safe list/i.test(photoM.reason), photoM)
  check('MySQL：0.00::numeric 灰掉并说明「默认值无法安全回写」',
    !!ratiosM && ratiosM.disabled === true && /默认值|default value/i.test(ratiosM.reason), ratiosM)
  check('MySQL：外键灰掉并说明「不生成」',
    !!fkM && fkM.disabled === true && /外键|Foreign key/i.test(fkM.reason), fkM)
  check('MySQL：一致的列（keep_me）不进列表', (await rowState('keep_me')) === null)

  const barM = await bar()
  check('MySQL：未勾选时无半选、按钮禁用',
    barM && barM.allChecked === false && barM.allIndeterminate === false &&
      barM.btnDisabled === true, barM)
  await clickAll()
  const barAll = await bar()
  check('MySQL：全选 → 7 条全勾上、按钮 7 句',
    barAll && barAll.allChecked === true &&
      norm(barAll.btnText).endsWith('7') && barAll.btnDisabled === false, barAll)
  await clickAll()
  const barNone = await bar()
  check('MySQL：再点全选 → 全部取消、按钮回到禁用',
    barNone && barNone.allChecked === false && barNone.btnDisabled === true, barNone)

  await clickRow('note')
  await clickRow('legacy')
  const pick2 = await bar()
  check('MySQL：勾 2 条 → 全选框半选、按钮 2 句',
    pick2 && pick2.allIndeterminate === true && norm(pick2.btnText).endsWith('2'), pick2)
  await shot('mysql-ddl-preview')

  const opsBeforeM = await cdp.jeval('window.__ops.length')
  await cdp.click(pick2.btnXY.x, pick2.btnXY.y)
  await waitFor(cdp, '!window.__diffOpen()', 'apply closed modal', 8000)
  // 提示条几秒就消失，必须趁切页签之前抓
  const toastM = await waitFor(cdp,
    '/未执行|not executed/i.test(String(document.body.innerText))', 'insert toast', 4000)
  if (await clickPageTab('SQL') !== 'ok') check('MySQL：切回 SQL 页', false, 'no-sql-tab')
  const linesM = await editorLines()
  check('MySQL：编辑器里 = 手写 1 句 + 勾选的 2 句（顺序按差异序，不多不少）',
    linesM.length === 3 && linesM[0] === 'SELECT 1' &&
      linesM[1] === "ALTER TABLE `demo`.`t_a` ADD COLUMN `note` varchar(64) COMMENT '备注';" &&
      linesM[2] === 'ALTER TABLE `demo`.`t_a` DROP COLUMN `legacy`;', linesM)
  // 切页签/刷新头部状态本来就会发 getDbTxState 这类只读 op，不冲突
  check('MySQL：全程零执行 —— 落点没有发出任何写/执行类 op',
    (await writeOps()).length === 0,
    { ops: await cdp.jeval('JSON.stringify(window.__ops.slice(' + opsBeforeM + '))') })
  check('MySQL：落点后提示「已插入编辑器，未执行」', toastM)

  // 换一对表：上一对的勾选必须作废，否则 A 表的语句会落进别的表
  // （入口在结构页工具条上，先切回结构页）
  await clickPageTab('表结构|Structure')
  await cdp.eval('window.__diffBtn().click()')
  await waitFor(cdp, 'window.__diffOpen()', 'diff reopened', 10000)
  await sleep(400)
  const swap = await pickTarget('t_a')
  check('换选择：A=B（自己比自己）说「结构一致」，说明条与按钮一起收掉',
    swap === 'ok' &&
      await waitFor(cdp, 'window.__diffHint().some(t => /结构一致|identical|same structure/i.test(t))',
        'same hint', 8000) && (await bar()) === null, { swap })
  const back = await pickTarget('t_b')
  const rowsBack = await waitFor(cdp, 'window.__diffRows().length >= 10', 'rows back', 15000)
  const resetChecked = await cdp.jeval(
    'JSON.stringify(window.__diffRows().filter(r => !r.disabled).map(r => r.checked))')
  check('换回原配对：勾选作废（没有残留勾选），按钮回到禁用',
    back === 'ok' && rowsBack && resetChecked.length > 0 && resetChecked.every(c => c === false) &&
      (await bar()).btnDisabled === true,
    { back, rowsBack, resetChecked })
  await cdp.eval('window.__diffClose()')

  // ══ 腿 3：PG 桩（同一差异形状，语法不能串门）═══════════════════════════
  await cdp.eval('window.__stubShape = "pg"')
  const pgTab = await openTab(cdp, {
    title: 'postgres root@127.0.0.1:5432/demo',
    dbType: 'postgres',
    dbHost: '127.0.0.1',
    dbPort: 5432,
    dbUser: 'root',
    dbPassword: '',
    dbName: 'demo',
    dbSsl: false,
    readOnly: true,
    production: false
  })
  await waitFor(cdp, `window.store.activeTabId === ${J(pgTab)}`, 'pg tab active', 20000)
  const seededP = await seedEditor('SELECT 1')
  const pOpen = await openDiff(['demo', 'public', 't_a'], 't_b')
  check('PG 腿：A/B = demo.public.t_a / demo.public.t_b（schema 层也在定位里）',
    pOpen === 'ok' &&
      (await cdp.jeval('JSON.stringify(window.__diffSelTexts())')).join(',') ===
      'demo.public.t_a,demo.public.t_b',
    { pOpen, seededP, sels: await cdp.jeval('JSON.stringify(window.__diffSelTexts())') })
  await waitFor(cdp, 'window.__diffRows().length >= 10', 'pg rows', 15000)

  const noteP = await rowState('note')
  const amountP = await rowState('amount')
  const statusP = await rowState('status')
  const idxNoteP = await rowState('idx_note')
  const idxLegacyP = await rowState('idx_legacy')
  const photoP = await rowState('photo')
  check('PG：定位是 schema.table（双引号、不带库名）',
    !!noteP && noteP.sqls[0] === 'ALTER TABLE "public"."t_a" ADD COLUMN "note" varchar(64)', noteP)
  check('PG：勾 1 条差异出 2 句（ADD COLUMN 与 COMMENT ON COLUMN 分开）',
    !!noteP && noteP.sqls.length === 2 &&
      noteP.sqls[1] === 'COMMENT ON COLUMN "public"."t_a"."note" IS \'备注\'', noteP)
  check('PG：改类型只发 ALTER COLUMN TYPE（不做 MODIFY 全定义重写）',
    !!amountP && amountP.sqls[0] ===
      'ALTER TABLE "public"."t_a" ALTER COLUMN "amount" TYPE decimal(12,2)', amountP)
  check('PG：改默认值走 SET DEFAULT',
    !!statusP && statusP.sqls[0] ===
      'ALTER TABLE "public"."t_a" ALTER COLUMN "status" SET DEFAULT \'paid\'', statusP)
  check('PG：索引增 → CREATE INDEX、索引删 → DROP INDEX IF EXISTS',
    !!idxNoteP && idxNoteP.sqls[0] === 'CREATE INDEX "idx_note" ON "public"."t_a" ("note")' &&
    !!idxLegacyP && idxLegacyP.sqls[0] === 'DROP INDEX IF EXISTS "idx_legacy"',
    { idxNoteP, idxLegacyP })
  check('PG：护栏同形 —— blob / :: 默认值 / 外键一样只报差异',
    !!photoP && photoP.disabled === true && /白名单|outside the safe list/i.test(photoP.reason) &&
      (await rowState('ratios')).disabled === true &&
      (await rowState('fk_note_ref')).disabled === true, photoP)
  await clickAll()
  const allP = await bar()
  // 句数按"语句"计、不是按"差异条数"计：PG 的加注释一条差异出两句，
  // 所以全选时按钮数字 = 各条 sqls 之和（比可勾条目多 1）
  const enabledP = await cdp.jeval('JSON.stringify(window.__diffRows().filter(r => !r.disabled))')
  const stmtP = enabledP.reduce((a, r) => a + r.sqls.length, 0)
  check('PG：全选 → 7 条差异、按钮 8 句（note 一条出两句，句数 > 条数）',
    allP && allP.allChecked === true && enabledP.length === 7 && stmtP === 8 &&
      norm(allP.btnText).endsWith(String(stmtP)),
    { btn: allP && allP.btnText, rows: enabledP.map(r => r.name + ':' + r.sqls.length) })
  await shot('pg-ddl-preview')

  await clickAll()
  await clickRow('note')
  const p2 = await bar()
  check('PG：勾 note 一条 → 按钮 2 句', p2 && norm(p2.btnText).endsWith('2'), p2)
  const opsBeforeP = await cdp.jeval('window.__ops.length')
  await cdp.click(p2.btnXY.x, p2.btnXY.y)
  await waitFor(cdp, '!window.__diffOpen()', 'pg apply closed modal', 8000)
  await clickPageTab('SQL')
  const linesP = await editorLines()
  check('PG：编辑器里 1 句手写 + 2 句生成，且不含 MySQL 反引号 / MODIFY 语法',
    linesP.length === 3 && linesP[0] === 'SELECT 1' &&
      linesP[1] === 'ALTER TABLE "public"."t_a" ADD COLUMN "note" varchar(64);' &&
      linesP[2] === 'COMMENT ON COLUMN "public"."t_a"."note" IS \'备注\';' &&
      linesP.every(l => l.indexOf('`') < 0 && !/MODIFY COLUMN/.test(l)), linesP)
  check('PG：零执行 —— 生成与落点全程没发出任何写/执行类 op',
    (await writeOps()).length === 0,
    { ops: await cdp.jeval('JSON.stringify(window.__ops.slice(' + opsBeforeP + '))') })

  // ══ 腿 4：浅色主题（语句预览与说明条跟着 token 变）════════════════════
  await clickPageTab('表结构|Structure')
  await cdp.eval('window.__diffBtn().click()')
  await waitFor(cdp, 'window.__diffOpen()', 'diff open for theme', 10000)
  await sleep(500)
  await pickTarget('t_b')
  await waitFor(cdp, 'window.__diffRows().length >= 10', 'rows for theme', 15000)
  await clickAll()
  const colorDark = await cdp.jeval('window.__color(".db-diff-ddl-sql")')
  const themeIds = await cdp.jeval(
    "JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const curTheme = await cdp.eval('(() => { const c = window.store._config || {}; return c.theme })()')
  const lightId = themeIds.find(id => /light/i.test(String(id))) ||
    themeIds.find(id => String(id) !== String(curTheme))
  let colorLight = null
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + J(lightId) + ')')
    await sleep(1300)
    colorLight = await cdp.jeval('window.__color(".db-diff-ddl-sql")')
    await shot('pg-ddl-light')
    await cdp.eval('window.store.setTheme(' + J(curTheme) + ')')
    await sleep(900)
  }
  check('浅色主题：语句预览颜色跟着 token 变（不是写死的颜色）',
    !!lightId && norm(colorDark) !== norm(colorLight), { colorDark, colorLight, lightId })
  await cdp.eval('window.__diffClose()')

  const errs = await cdp.jeval('JSON.stringify(window.__errs)')
  check('全程无未捕获异常 / 未处理 rejection', errs.length === 0, errs)

  console.log('\n════ N3a 结构对比 → 候选 DDL：CDP 验收 ════')
  const failed = results.filter(r => !r.ok)
  console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length)
  failed.forEach(f => console.log('  FAIL: ' + f.name + ' :: ' + JSON.stringify(f.detail)))
  console.log('截图目录 ' + SHOT_DIR)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
