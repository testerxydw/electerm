#!/usr/bin/env node
/**
 * N3b 受限表设计器 —— CDP 实机验收
 *
 * 纯函数部分由 src/test/unit-ci/db-table-design.spec.js 钉死（23 条，含验收原文
 * "删一列 + 加一索引 + 改注释 → 3 条、勾 2 得 2"），这里只钉接上界面之后才会坏的事：
 *   1) 真库腿（node:sqlite 文件）：设计器打开的是**真表**，列/索引/注释从
 *      getTableStructure 的 v2 契约里来；SQLite 的 alterDdl=false → 顶部只读横幅、
 *      每条差异都灰掉、按钮 0 句 —— 能力位降级在真引擎上成立；
 *   2) 验收三条（MySQL 桩）：删列 + 加索引 + 改注释 = 3 条差异，勾 2 条 →
 *      编辑器里正好 2 句 + 用户手写的 1 句，全程零执行；
 *   3) 改名没有入口：已有列/索引的名字栏 disabled，主键行只给徽标不给删除钮；
 *   4) 草稿不合法就不出预览：空列名 / 索引没选列 → 只报错条，一条语句都不给；
 *   5) 方言不串门：同一形状在 PG 桩上是 COMMENT ON TABLE / CREATE INDEX，
 *      没有反引号、没有 MODIFY；
 *   6) 每次改动作废勾选；重新载入确实带 refresh:true（刚 ALTER 过的表不能被 60s
 *      结构缓存当基准）；
 *   7) 双主题：语句预览的颜色跟着 token 走。
 *
 * 本机没有可连的 MySQL/PG 服务（3306/5432 无人监听、也没装服务端），所以"MySQL/PG
 * 腿"是页内桩：语句字面由 unit-ci 逐条钉死，这里验的是接线与降级。真库腿是 sqlite 文件。
 *
 * 腿的顺序固定：真库腿在前 —— 桩腿整体替换 window.pre.runGlobalAsync 且不还原。
 *
 * 交互一律走页内 DOM 动作（按钮 / 勾选框 / 下拉都是 el.click()，输入走原生 setter +
 * input 事件）：设计器弹层会随渲染重排，坐标从量到点的这段时间里就不算数了，一次跑偏
 * 最坏落到页脚「关闭」，草稿整个没了。真鼠标只留给 CodeMirror —— 那是它唯一认的写入路径。
 * 另外 antd 会在两个汉字之间插一个空格（页脚实测「关 闭」），按文案匹配要先去空白。
 *
 * 用法：
 *   1) npm run compile && rsync -a src/app/common/ work/app/common/
 *   2) DISPLAY=:139 HOME=/tmp/electerm-n4a/home TMPDIR=/tmp/electerm-n3b/tmp \
 *        setsid ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9391 --no-sandbox --disable-gpu --window-size=1680,1050
 *   3) node self-test/n3b-table-design-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9391'
const SHOT_DIR = process.argv[3] || path.join(__dirname, '2026-11-08-n3b-shots')
const DEMO_DIR = '/tmp/electerm-n3b/demo'
const DB = path.join(DEMO_DIR, 'design.db')
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
  // 受控输入写入：只改 value 不会被 React 认，必须走原生 setter + input 事件
  window.__setInput = (el, text) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(text))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  window.__inp = el => (el ? (el.tagName === 'INPUT' ? el : el.querySelector('input')) : null)
  window.__designBtn = () => [...document.querySelectorAll('.db-struct-tools button')]
    .filter(window.__vis).find(b => /表设计|Table designer/i.test(b.innerText)) || null
  window.__designRoot = () => window.__one('.db-design')
  window.__designOpen = () => !!window.__designRoot()
  window.__block = re => {
    const r = window.__designRoot()
    if (!r) return null
    return [...r.querySelectorAll('.db-design-block')]
      .find(b => new RegExp(re, 'i').test(String((b.querySelector('.db-design-block-title') || {}).innerText || ''))) || null
  }
  window.__rowsOf = re => {
    const b = window.__block(re)
    if (!b) return []
    return [...b.querySelectorAll('.db-design-row')].filter(x => !x.classList.contains('db-design-head'))
  }
  window.__cellOf = (row, cls) => row.querySelector('.db-design-cell.' + cls)
  window.__colRows = () => window.__rowsOf('^列|Columns').map(row => {
    const name = window.__inp(window.__cellOf(row, 'is-name'))
    const type = window.__inp(window.__cellOf(row, 'is-type'))
    const bools = [...row.querySelectorAll('.db-design-cell.is-bool input')]
    const def = window.__inp(window.__cellOf(row, 'is-default'))
    const cmt = window.__inp(window.__cellOf(row, 'is-comment'))
    return {
      name: name ? name.value : null,
      nameDisabled: !!(name && name.disabled),
      type: type ? type.value : null,
      nullable: !!(bools[0] && bools[0].checked),
      hasDefault: !!(bools[1] && bools[1].checked),
      defaultValue: def ? def.value : null,
      defaultDisabled: !!(def && def.disabled),
      comment: cmt ? cmt.value : null
    }
  })
  window.__ixRows = () => window.__rowsOf('^索引|Indexes').map(row => {
    const name = window.__inp(window.__cellOf(row, 'is-name'))
    const sel = window.__cellOf(row, 'is-cols')
    const uniq = window.__inp(window.__cellOf(row, 'is-bool'))
    const del = window.__cellOf(row, 'is-del')
    return {
      name: name ? name.value : null,
      nameDisabled: !!(name && name.disabled),
      cols: sel ? [...sel.querySelectorAll('.ant-select-selection-item')].map(x => x.getAttribute('title') || x.innerText.trim()) : [],
      unique: !!(uniq && uniq.checked),
      uniqueDisabled: !!(uniq && uniq.disabled),
      isPk: !!(del && del.classList.contains('is-pk')),
      hasDel: !!(del && del.tagName === 'BUTTON')
    }
  })
  window.__comment = () => {
    const box = window.__one('.db-design-comment')
    const input = box ? box.querySelector('input') : null
    return input ? input.value : null
  }
  window.__changes = () => {
    const r = window.__designRoot()
    if (!r) return []
    return [...r.querySelectorAll('.db-design-change')].map(row => {
      const input = row.querySelector('.ant-checkbox-wrapper input')
      return {
        id: ((row.querySelector('.db-design-change-name') || {}).innerText || '').trim(),
        checked: !!(input && input.checked),
        disabled: !!(input && input.disabled),
        sqls: [...row.querySelectorAll('.db-design-sql')].map(x => x.innerText.trim()),
        reason: ((row.querySelector('.db-design-reason') || {}).innerText || '').trim() || null
      }
    })
  }
  window.__change = id => window.__changes().find(c => String(c.id).trim() === id) || null
  window.__changeIds = () => window.__changes().map(c => c.id)
  window.__hints = () => {
    const r = window.__designRoot()
    return r ? [...r.querySelectorAll('.db-design-hint')].map(x => x.innerText.trim()).filter(Boolean) : []
  }
  const normText = t => String(t == null ? '' : t).replace(/\\s+/g, ' ').trim()
  window.__alerts = () => {
    const r = window.__designRoot()
    return r ? [...r.querySelectorAll('.db-design-alert')].map(a => ({
      msg: normText((a.querySelector('.ant-alert-message') || a).innerText),
      desc: normText((a.querySelector('.ant-alert-description') || a).innerText)
    })) : []
  }
  // 关掉的弹层 DOM 还挂在 body 上（display:none），document.querySelector 会先撞进
  // 上一腿留下的那一个，量到的永远是旧数据 —— 页脚的读写都只认「看得见」的弹层
  window.__designModal = () => [...document.querySelectorAll('.db-table-design-modal')]
    .filter(window.__vis).pop() || null
  window.__footBtn = () => {
    const m = window.__designModal()
    const box = m ? m.querySelector('.ant-modal-footer') : null
    if (!box) return null
    const b = [...box.querySelectorAll('button')].find(x => /写入|Write to/i.test(x.innerText))
    return b ? { text: b.innerText.trim().replace(/\\s+/g, ' '), disabled: !!b.disabled } : null
  }
  window.__closeDesign = () => {
    const m = window.__designModal()
    const box = m ? m.querySelector('.ant-modal-footer') : null
    if (!box) return 'no-footer'
    // antd 会在两个汉字之间塞一个空格（页脚实测是「关 闭」），这里要比的是去空白后的整串
    const b = [...box.querySelectorAll('button')].find(x =>
      /关闭|close/i.test(String(x.innerText).replace(/\\s+/g, '')))
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__options = () => [...document.querySelectorAll('.ant-select-item-option')]
    .filter(window.__vis).map(o => normText(o.innerText))
  window.__structTools = () => [...document.querySelectorAll('.db-struct-tools button')]
    .filter(window.__vis).map(b => b.innerText.trim().replace(/\\s+/g, ''))
  window.__color = sel => {
    const el = window.__one(sel)
    return el ? getComputedStyle(el).color : null
  }
  // 动作层一律走 DOM：弹层里的行会随渲染重排，坐标从量到点的这段时间里已经不算数
  // （一次跑偏最坏落到页脚「关闭」，草稿整个没了）；本仓库既有自测对按钮/页签/树
  // 本来就是 el.click()，真鼠标只留给 CodeMirror —— 那是它唯一认的写入路径。
  window.__click = async el => {
    if (!el) return 'no-el'
    el.scrollIntoView({ block: 'center', inline: 'center' })
    // 滚动是异步的：等一帧再点，否则 React 拿到事件时元素已经不在原位
    await new Promise(r => requestAnimationFrame(() => r()))
    el.click()
    return 'clicked'
  }
  window.__rowBy = (blockRe, label) => window.__rowsOf(blockRe).find(r => {
    const i = window.__inp(window.__cellOf(r, 'is-name'))
    return i && i.value === label
  })
  window.__clickDelCol = async name => {
    const r = window.__rowBy('^列|Columns', name)
    if (!r) return 'no-row'
    const del = window.__cellOf(r, 'is-del')
    return (del && del.tagName === 'BUTTON')
      ? await window.__click(del)
      : 'no-del-button'
  }
  window.__clickAdd = async re => {
    const b = window.__block(re)
    if (!b) return 'no-block'
    return await window.__click(b.querySelector('.db-design-block-head button'))
  }
  window.__changeEl = id => {
    const r = window.__designRoot()
    if (!r) return null
    return [...r.querySelectorAll('.db-design-change')].find(x => normText(
      ((x.querySelector('.db-design-change-name') || {}).innerText || '')) === id) || null
  }
  // 勾选点 input：点 wrapper（label）会把事件转给 input，一次动作变两次 onChange
  window.__clickChange = async id => {
    const r = window.__changeEl(id)
    if (!r) return 'no-row'
    const input = r.querySelector('.ant-checkbox-wrapper input')
    if (!input) return 'no-input'
    if (input.disabled) return 'disabled'
    return await window.__click(input)
  }
  // label 传空 = 最后一行（新加的那行）
  window.__typeCell = async (blockRe, label, cls, text) => {
    const rows = window.__rowsOf(blockRe)
    const r = label ? window.__rowBy(blockRe, label) : rows[rows.length - 1]
    if (!r) return 'no-row'
    const el = window.__cellOf(r, cls)
    const input = window.__inp(el) || el
    if (!input || input.tagName !== 'INPUT') return 'no-input'
    if (input.disabled) return 'disabled'
    input.scrollIntoView({ block: 'center', inline: 'center' })
    await new Promise(res => requestAnimationFrame(() => res()))
    input.focus()
    window.__setInput(input, text)
    return String(input.value) === String(text) ? 'ok' : 'value-not-applied'
  }
  window.__typeComment = text => {
    const box = window.__one('.db-design-comment')
    const input = box ? box.querySelector('input') : null
    if (!input) return 'no-input'
    input.focus()
    window.__setInput(input, text)
    return String(input.value) === String(text) ? 'ok' : 'value-not-applied'
  }
  // antd Select 的开关挂在 mousedown 上，.click() 打不开下拉
  window.__openLastIxSel = async () => {
    const rows = window.__rowsOf('^索引|Indexes')
    const r = rows[rows.length - 1]
    if (!r) return 'no-row'
    const sel = window.__cellOf(r, 'is-cols')
    if (!sel) return 'no-select'
    sel.scrollIntoView({ block: 'center', inline: 'center' })
    await new Promise(res => requestAnimationFrame(() => res()))
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return 'clicked'
  }
  window.__clickOption = async text => {
    const o = [...document.querySelectorAll('.ant-select-item-option')]
      .filter(window.__vis).find(x => normText(x.innerText) === text)
    if (!o) return 'no-option'
    return await window.__click(o)
  }
  window.__clickApply = async () => {
    const m = window.__designModal()
    const box = m ? m.querySelector('.ant-modal-footer') : null
    if (!box) return 'no-footer'
    const b = [...box.querySelectorAll('button')].find(x => /写入|Write to/i.test(normText(x.innerText)))
    if (!b) return 'no-apply-button'
    if (b.disabled) return 'disabled'
    return await window.__click(b)
  }
  window.__errs = []
  window.addEventListener('error', ev => {
    window.__errs.push(String((ev.error && ev.error.stack) || ev.message || '').split('\\\\n').slice(0, 3).join(' | '))
  })
  window.addEventListener('unhandledrejection', ev => {
    window.__errs.push('REJ ' + String((ev.reason && ev.reason.stack) || ev.reason || '').split('\\\\n').slice(0, 3).join(' | '))
  })
  return 'probes-ready'
})()`

// ── 真库腿：node:sqlite 文件，一张有注释/主键/普通索引的表 ───────────
const buildRealDb = () => {
  fs.rmSync(DEMO_DIR, { recursive: true, force: true })
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  const db = new DatabaseSync(DB)
  db.exec(`
    CREATE TABLE t_design (
      id integer primary key,
      note text not null default 'x',
      legacy text,
      amount real
    );
    CREATE INDEX idx_legacy ON t_design (legacy);
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

// ── 桩腿：一页内存结构，mysql 与 pg 共用（形状照验收那条：能删列 / 加索引 / 改注释）
const STRUCTURES = `(() => {
  const col = (name, extra) => Object.assign({
    name, dataType: 'int', columnType: 'int(11)', nullable: false, defaultValue: null,
    isPrimaryKey: false, ordinal: 1, comment: null, maxLength: null
  }, extra || {})
  const idx = (name, columns, extra) => Object.assign({
    name, unique: false, primary: false, columns, method: 'BTREE'
  }, extra || {})
  const STRUCT = {
    type: 'table',
    comment: '老表',
    columns: [
      col('id', { isPrimaryKey: true }),
      col('legacy'),
      col('email', { columnType: 'varchar(64)', dataType: 'varchar', maxLength: 64, nullable: true }),
      col('status', { columnType: 'varchar(16)', dataType: 'varchar', maxLength: 16, defaultValue: 'new' })
    ],
    indexes: [
      idx('PRIMARY', ['id'], { unique: true, primary: true }),
      idx('idx_legacy', ['legacy'])
    ],
    foreignKeys: [{
      name: 'fk_org', columns: ['legacy'], refSchema: null, refTable: 't_org',
      refColumns: ['legacy'], onDelete: 'RESTRICT', onUpdate: 'NO ACTION'
    }]
  }
  window.__dbStub = 'n3b'
  window.__ops = []
  window.__structCalls = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      window.__ops.push(op)
      if (op === 'getTableStructure') {
        window.__structCalls.push(JSON.parse(JSON.stringify(a[2] || {})))
        return Promise.resolve(JSON.parse(JSON.stringify(STRUCT)))
      }
      if (op === 'getMetadata') {
        const leaves = [{ name: 't_design', type: 'table' }, { name: 't_org', type: 'table' }]
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

  const norm = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim()
  const writeOps = () => cdp.jeval(
    'JSON.stringify(window.__ops.filter(o => /executeSql|^updateCells?$|^insertRow$|^deleteRows$/.test(o)))')

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
  // 一路点到目标表的结构页，再按工具条上的「表设计」
  const openDesign = async labels => {
    // 设计器弹层是 portal，挂在 body 上、不跟着页签隐藏：上一腿没关干净的话，
    // 这一腿所有读写都会落进那个旧草稿里。先关掉，关不掉就当场报错，不许带着跑。
    if (await cdp.eval('window.__designOpen()')) {
      const c = await cdp.eval('window.__closeDesign()')
      if (!await waitFor(cdp, '!window.__designOpen()', 'stale designer closed', 8000)) {
        return 'stale-designer:' + c
      }
    }
    for (const l of labels) {
      const r = await clickTree(l)
      if (r !== 'ok') return 'no-tree-node:' + l + '=' + r
    }
    if (await clickPageTab('表结构|Structure') !== 'ok') return 'no-struct-tab'
    if (!await cdp.eval('!!window.__designBtn()')) return 'no-design-button'
    await cdp.eval('window.__designBtn().click()')
    return await waitFor(cdp, 'window.__designOpen()', 'designer modal', 20000)
      ? 'ok'
      : 'modal-not-open'
  }
  const cols = () => cdp.jeval('JSON.stringify(window.__colRows())')
  const ixs = () => cdp.jeval('JSON.stringify(window.__ixRows())')
  const changes = () => cdp.jeval('JSON.stringify(window.__changes())')
  const change = id => cdp.jeval('JSON.stringify(window.__change(' + J(id) + '))')
  const alerts = () => cdp.jeval('JSON.stringify(window.__alerts())')
  const foot = () => cdp.jeval('JSON.stringify(window.__footBtn())')
  // 交互一律走页内 DOM 动作（见 HELPERS 里 __click 的注释）；返回值不是 'clicked'
  // 就是失败原因，拼进判据 detail，坏在哪一步能直接说出来
  const act = async (expr, label) => {
    const r = await cdp.eval(expr)
    await sleep(420)
    return r === 'clicked' ? 'ok' : String(r) + ':' + label
  }
  const typeCell = async (blockRe, label, cls, text) => {
    const r = await cdp.eval('window.__typeCell(' + J(blockRe) + ',' + J(label) + ',' +
      J(cls) + ',' + J(text) + ')')
    await sleep(420)
    return r
  }
  const clickChange = id => act('window.__clickChange(' + J(id) + ')', 'change:' + id)
  const clickAdd = re => act('window.__clickAdd(' + J(re) + ')', 'add:' + re)
  const clickDelCol = name => act('window.__clickDelCol(' + J(name) + ')', 'del-col:' + name)
  const typeComment = async text => {
    const r = await cdp.eval('window.__typeComment(' + J(text) + ')')
    await sleep(420)
    return r
  }
  const pickIxOption = async option => {
    const open = await act('window.__openLastIxSel()', 'ix-select')
    if (open !== 'ok') return open
    if (!await waitFor(cdp, `window.__options().includes(${J(option)})`, 'column options', 6000)) {
      return 'option-missing:' + option
    }
    await sleep(320)
    return await act('window.__clickOption(' + J(option) + ')', 'option:' + option)
  }
  const clickApply = () => act('window.__clickApply()', 'apply')
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
    return norm(await cdp.jeval(
      "(() => { const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]; return ed ? ed.innerText : null })()"))
  }
  const editorLines = async () => String(await cdp.jeval(
    "(() => { const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]; return ed ? ed.innerText : '' })()"
  ) || '').split('\n').map(norm).filter(Boolean)

  // ══ 腿 1：真 node:sqlite —— 真表进得来，能力位降得下去 ══════════════════
  buildRealDb()
  const sqliteTab = await openTab(cdp, {
    title: 'sqlite ' + path.basename(DB),
    dbType: 'sqlite',
    dbFile: DB,
    readOnly: false,
    production: false
  })
  const up = await waitFor(cdp, `window.store.activeTabId === ${J(sqliteTab)}`, 'sqlite tab active', 30000) &&
    await waitFor(cdp, "[...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).length > 0",
      'sqlite tree', 30000)
  check('真库腿：SQLite 页签连上、树里有库节点', up, sqliteTab)

  const dOpen = await openDesign(['main', 't_design'])
  check('真库腿：结构页工具条有「表设计」入口，点了能开设计器', dOpen === 'ok', {
    dOpen,
    tools: await cdp.jeval('JSON.stringify(window.__structTools())')
  })

  const realCols = await cols()
  check('真库腿：列从真表 v2 结构逐行预填（4 列、类型是真类型、名字栏只读）',
    realCols.length === 4 &&
      realCols.map(c => c.name).join(',') === 'id,note,legacy,amount' &&
      realCols.every(c => c.nameDisabled === true) &&
      realCols[1].type === 'TEXT' && realCols[3].type === 'REAL',
    realCols.map(c => c.name + ':' + c.type))
  const realIxs = await ixs()
  check('真库腿：主键行只给徽标不给删除钮，普通索引可删（真表 idx_legacy 在列）',
    realIxs.some(ix => ix.isPk === true && ix.name === 'PRIMARY' && ix.hasDel === false &&
      ix.uniqueDisabled === true) &&
      realIxs.some(ix => ix.isPk === false && ix.name === 'idx_legacy' && ix.hasDel === true &&
        ix.nameDisabled === true),
    realIxs.map(ix => ix.name + ':pk=' + ix.isPk + ':del=' + (ix.hasDel ? 1 : 0)))
  check('真库腿：默认值勾与库里一致 —— note 有 DEFAULT \'x\'，legacy 没有',
    realCols[1].hasDefault === true && /'x'/.test(realCols[1].defaultValue) &&
      realCols[2].hasDefault === false && realCols[2].defaultDisabled === true,
    realCols.map(c => c.name + ':' + c.hasDefault + ':' + c.defaultValue))

  const emptyChanges = await changes()
  const noneHint = await cdp.jeval('JSON.stringify(window.__hints())')
  const footNone = await foot()
  check('真库腿：刚打开没有假变更（0 条差异、提示「还没有改动」、按钮禁用 0 句）',
    emptyChanges.length === 0 && noneHint.some(t => /还没有改动|Nothing changed/i.test(t)) &&
      footNone && footNone.disabled === true && /0\s*$/.test(footNone.text),
    { emptyChanges, noneHint, footNone })
  const sAlerts = await alerts()
  check('真库腿：SQLite 顶部有只读预览横幅（判据是 alterDdl 能力位）',
    sAlerts.some(a => /只读预览|read-only preview/i.test(a.msg)), sAlerts)

  const delReal = await clickDelCol('legacy')
  await sleep(420)
  const sChanges = await changes()
  check('真库腿：删掉真表的 legacy 列 → 差异报出来，但每条都灰掉、零语句、说明是能力位',
    delReal === 'ok' &&
    sChanges.length === 1 && sChanges[0].id === 'column:legacy' &&
      sChanges[0].disabled === true && sChanges[0].sqls.length === 0 &&
      /ALTER|能力|白名单|不生成|cannot|only covers|no SQL dialect/i.test(String(sChanges[0].reason)),
    sChanges)
  const sFoot = await foot()
  check('真库腿：灰条目勾不动 → 按钮仍然 0 句、禁用（不会生成半截脚本）',
    sFoot && sFoot.disabled === true && /0\s*$/.test(sFoot.text), sFoot)
  await shot('sqlite-real-readonly-preview')

  // 空列名 / 索引没选列 → 草稿不合法，只报错条、不给预览
  const addEmpty = await clickAdd('^列|Columns')
  await sleep(200)
  // 词条是「草稿有这些问题，先修掉才能生成：」—— 中间那个「这些」不能漏
  const issuesAlert = await waitFor(cdp,
    'window.__alerts().some(a => /草稿有这些问题|Fix these before/i.test(a.msg))', 'issues alert', 8000)
  const blockedChanges = await cdp.jeval('window.__changes().length')
  check('真库腿：加了空名列 → 报「草稿有这些问题」并整体不给预览',
    issuesAlert && blockedChanges === 0, {
      addEmpty,
      issuesAlert,
      blockedChanges,
      cols: (await cols()).map(c => c.name),
      alerts: await alerts()
    })
  const sClosed = await cdp.eval('window.__closeDesign()')
  const sClosedOk = await waitFor(cdp, '!window.__designOpen()', 'designer closed', 8000)
  check('真库腿：点「关闭」关得掉（弹层挂在 body 上，留着会把下一腿的读写全串进旧草稿）',
    sClosed === 'ok' && sClosedOk === true, { sClosed, sClosedOk })

  // ══ 腿 2：MySQL 桩 —— 验收三条（删列 + 加索引 + 改注释 → 3 条，勾 2 得 2）═══
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
  const mOpen = await openDesign(['demo', 't_design'])
  check('MySQL 腿：桩表设计器打开（无只读横幅：alterDdl=true）',
    mOpen === 'ok' && !(await alerts()).some(a => /只读预览/i.test(a.msg)), { mOpen })

  // 三处改动：删 legacy、加索引 ix_email、改表注释
  const delM = await clickDelCol('legacy')
  const addIx = await clickAdd('^索引|Indexes')
  const namedIx = await typeCell('^索引|Indexes', null, 'is-name', 'ix_email')
  const picked = await pickIxOption('email')
  const commentM = await typeComment('新注释')
  await sleep(520)
  const mChanges = await changes()
  check('MySQL 腿：删一列 + 加一索引 + 改注释 = 3 条差异（' + [delM, addIx, namedIx,
    picked, commentM].join('/') + '）',
  delM === 'ok' && mChanges.length === 3 && mChanges.map(c => c.id).join(',') ===
      'table:comment,column:legacy,index:ix_email',
  { mChanges: mChanges.map(c => c.id + ':' + c.sqls.join(' ')), namedIx, picked, commentM })
  check('MySQL 腿：三条都能勾，语法各归各位（DROP COLUMN / ADD INDEX / ALTER TABLE ... COMMENT）',
    mChanges.every(c => c.disabled === false) &&
      mChanges[0].sqls[0] === 'ALTER TABLE `demo`.`t_design` COMMENT \'新注释\'' &&
      mChanges[1].sqls[0] === 'ALTER TABLE `demo`.`t_design` DROP COLUMN `legacy`' &&
      /ADD INDEX `ix_email` \(`email`\)/.test(mChanges[2].sqls[0]),
    mChanges.map(c => c.sqls))
  await clickChange('column:legacy')
  await clickChange('index:ix_email')
  const pick2 = await foot()
  check('MySQL 腿：勾 2 条 → 按钮写「2」句、可点',
    pick2 && pick2.disabled === false && /2\s*$/.test(pick2.text), pick2)
  await shot('mysql-designer-3-changes')

  const opsBefore = await cdp.jeval('window.__ops.length')
  const appliedM = await clickApply()
  if (appliedM !== 'ok') check('MySQL 腿：点「写入 SQL 编辑器」', false, appliedM)
  await waitFor(cdp, '!window.__designOpen()', 'apply closes designer', 8000)
  const toastM = await waitFor(cdp,
    '/未执行|not executed/i.test(String(document.body.innerText))', 'insert toast', 4000)
  await clickPageTab('SQL')
  const linesM = await editorLines()
  check('MySQL 腿：编辑器里 = 手写 1 句 + 勾选的 2 句（未勾的第 3 句没进去）',
    linesM.length === 3 && linesM[0] === 'SELECT 1' &&
      linesM[1] === 'ALTER TABLE `demo`.`t_design` DROP COLUMN `legacy`;' &&
      linesM[2].indexOf('ADD INDEX `ix_email`') > 0, linesM)
  check('MySQL 腿：全程零执行 —— 落点只发只读 op，没有 executeSql/写类 op',
    (await writeOps()).length === 0,
    { ops: await cdp.jeval('JSON.stringify(window.__ops.slice(' + opsBefore + '))') })
  check('MySQL 腿：落点后提示「已插入编辑器，未执行」', toastM)

  // 重新载入走 refresh:true（刚 ALTER 过的表不能拿 60s 缓存当基准）
  await clickPageTab('表结构|Structure')
  await cdp.eval('window.__designBtn().click()')
  await waitFor(cdp, 'window.__designOpen()', 'designer reopened', 12000)
  await sleep(600)
  const calls = await cdp.jeval('JSON.stringify(window.__structCalls.slice(-2))')
  check('MySQL 腿：取结构带 refresh:true，绕开 60s 缓存',
    calls.length > 0 && calls.every(c => c.refresh === true), calls)
  const reopen = await changes()
  const allUnchecked = await cdp.jeval('JSON.stringify(window.__changes().map(c => c.checked))')
  check('MySQL 腿：重开后草稿从当下结构重建 → 0 条差异、没有残留勾选',
    reopen.length === 0 && allUnchecked.length === 0, { reopen, allUnchecked })

  // 幂等展示：再来一次同样的改动，得到同一串语句
  const delAgain = await clickDelCol('legacy')
  await sleep(420)
  const again = await change('column:legacy')
  check('MySQL 腿：同一改动重做一遍得到同一句（预览可反复看）',
    delAgain === 'ok' && again && again.sqls[0] === 'ALTER TABLE `demo`.`t_design` DROP COLUMN `legacy`', again)

  // 改名没有入口：既有列/索引的名字栏 disabled
  const nameGate = await cdp.jeval('JSON.stringify({ ' +
    'col: window.__colRows().filter(c => !c.nameDisabled).map(c => c.name), ' +
    'ix: window.__ixRows().filter(i => !i.nameDisabled).map(i => i.name) })')
  check('MySQL 腿：已有列/索引的名字栏全部只读（改名会被读成删+加）',
    nameGate.col.length === 0 && nameGate.ix.length === 0, nameGate)
  await cdp.eval('window.__closeDesign()')
  await waitFor(cdp, '!window.__designOpen()', 'closed after mysql leg', 8000)

  // ══ 腿 3：PG 桩 —— 同一形状，语法不串门 ════════════════════════════════
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
  // 每个页签各有自己的 SQL 编辑器：这里得在这个页签里另放一句，
  // 才能证明 PG 的语句落进的是**当前页签**、且接在用户已写的那句后面
  const seededP = await seedEditor('SELECT 2')
  check('PG 腿：这个页签的编辑器先放一句手写的（和 MySQL 页签互不串）',
    seededP === 'SELECT 2', seededP)
  const pOpen = await openDesign(['demo', 'public', 't_design'])
  check('PG 腿：设计器打开在 demo.public.t_design（schema 也在定位里）', pOpen === 'ok', pOpen)
  const pCmt = await typeComment('新注释')
  const pAdd = await clickAdd('^索引|Indexes')
  const pIx = await typeCell('^索引|Indexes', null, 'is-name', 'ix_email')
  const pPick = await pickIxOption('email')
  await sleep(520)
  const pChanges = await changes()
  check('PG 腿：改注释 → COMMENT ON TABLE ... IS，加索引 → CREATE INDEX ... ON（' +
    [pCmt, pAdd, pIx, pPick].join('/') + '）',
  pCmt === 'ok' && pAdd === 'ok' && pIx === 'ok' && pPick === 'ok' &&
    pChanges.length === 2 &&
      pChanges[0].sqls[0] === 'COMMENT ON TABLE "public"."t_design" IS \'新注释\'' &&
      /^CREATE INDEX "ix_email" ON "public"."t_design" \("email"\)$/.test(pChanges[1].sqls[0]),
  pChanges.map(c => c.id + ':' + c.sqls.join(' ')))
  check('PG 腿：一条 PG 语句都不含 MySQL 反引号 / MODIFY / ADD INDEX',
    pChanges.every(c => c.sqls.join(' ').indexOf('`') < 0 &&
      !/MODIFY COLUMN|ADD INDEX/.test(c.sqls.join(' '))),
    pChanges.map(c => c.sqls))
  const pChecked = await clickChange('table:comment')
  const pApplied = await clickApply()
  if (pApplied !== 'ok') check('PG 腿：点「写入 SQL 编辑器」', false, { pChecked, pApplied })
  await waitFor(cdp, '!window.__designOpen()', 'pg apply closes', 8000)
  await clickPageTab('SQL')
  const linesP = await editorLines()
  check('PG 腿：勾 1 条 → 编辑器多出 1 句 PG 语法（手写的 SELECT 2 还在第 1 行）',
    pChecked === 'ok' && linesP[0] === 'SELECT 2' && linesP[linesP.length - 1] ===
      'COMMENT ON TABLE "public"."t_design" IS \'新注释\';',
    { pChecked, pApplied, linesP })

  // ══ 腿 4：浅色主题 —— 语句预览颜色跟着 token 走 ════════════════════════
  await clickPageTab('表结构|Structure')
  await cdp.eval('window.__designBtn().click()')
  await waitFor(cdp, 'window.__designOpen()', 'designer for theme', 12000)
  await sleep(500)
  await typeComment('主题注释')
  await sleep(520)
  const colorDark = await cdp.jeval('window.__color(".db-design-sql")')
  const themeIds = await cdp.jeval(
    "JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const curTheme = await cdp.eval('(() => { const c = window.store._config || {}; return c.theme })()')
  const lightId = themeIds.find(id => /light/i.test(String(id))) ||
    themeIds.find(id => String(id) !== String(curTheme))
  let colorLight = null
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + J(lightId) + ')')
    await sleep(1400)
    colorLight = await cdp.jeval('window.__color(".db-design-sql")')
    await shot('designer-light-theme')
    await cdp.eval('window.store.setTheme(' + J(curTheme) + ')')
    await sleep(900)
  }
  check('浅色主题：语句预览颜色跟着 token 变（不是写死的颜色）',
    !!lightId && norm(colorDark) !== norm(colorLight), { colorDark, colorLight, lightId })
  await shot('designer-dark-theme')
  await cdp.eval('window.__closeDesign()')

  const errs = await cdp.jeval('JSON.stringify(window.__errs)')
  check('全程无未捕获异常 / 未处理 rejection', errs.length === 0, errs)

  console.log('\n════ N3b 受限表设计器：CDP 验收 ════')
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
