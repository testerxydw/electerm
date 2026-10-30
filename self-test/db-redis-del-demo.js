#!/usr/bin/env node
/**
 * H7b-3 Redis 批量删键 —— CDP 实机演示/回归（假 Redis，全程不碰真库）
 *
 * 后端 UNLINK 与分块纯函数已由 src/test/unit-ci/db-redis-del.spec.js 钉死，
 * 这里验的是"接到一起之后"的行为：
 *   1) 没勾选时入口不可点；勾选后按钮带数字，工具行常驻"已选 N"
 *   2) 跨页保留勾选（一页最多 200 个键，不跨页就永远只有一批）
 *   3) 弹层=预览+确认：标题数量、UNLINK 说明、只列前 20 个键 + "另有 N 个"
 *   4) 取消 = 零调用；确认才发，且分批 500、只带 dbIndex+keys（readOnly 归主进程）
 *   5) 进度按 unlink 的实际删除数累加（不是"发出去几个"）
 *   6) 中途失败停在弹层：红条 + 已删除 x/total、只剩"关闭"，不给重试
 *   7) 删完：清勾选、选中键的详情一起清、原页重拉、左侧键数刷新
 *   8) 只读：复选框与入口都禁用，主进程还有第二道闸
 *   9) production：多弹一次 E1 风险确认，取消照样零调用
 *  10) 样式：键名走数据面等宽字体链，浅色主题下颜色跟着变
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync 且跑完不还原。
 *
 * 用法：
 *   1) npm run vite-build && /usr/bin/rsync -a src/app/ work/app/
 *   2) 起带 --remote-debugging-port 的实例
 *   3) node self-test/db-redis-del-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-redis-del-shots')

const KEY_COUNT = 1200
const PAGE = 200

const STUB = `
(() => {
  window.__keys = Array.from({ length: ${KEY_COUNT} }, (_, i) => 'sess:' + String(i + 1).padStart(4, '0'))
  window.__calls = []
  window.__delCalls = []
  window.__failAt = -1
  window.__delay = 0
  window.__count = sub => window.__calls.filter(c => c.indexOf(sub) === 0).length
  window.__space = () => window.__keys
  // SCAN 游标这里用可见下标模拟（真库游标不透明，但列表只当黑盒推进）
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        window.__calls.push('getMetadata ' + JSON.stringify(args))
        return Promise.resolve([{ name: 'db0', type: 'database', count: window.__keys.length }])
      }
      if (op === 'getPageData') {
        window.__calls.push('getPageData ' + JSON.stringify(args))
        const off = Number(args.cursor || 0) || 0
        const size = Number(args.pageSize || ${PAGE}) || ${PAGE}
        const names = window.__keys.slice(off, off + size)
        const next = off + names.length
        const rows = names.map(n => (args.keysOnly ? { name: n } : { name: n, type: 'string', ttl: -1 }))
        return Promise.resolve({
          rows,
          nextCursor: String(next),
          hasMore: next < window.__keys.length
        })
      }
      if (op === 'getKeyDetail') {
        return Promise.resolve({ type: 'string', value: 'v-' + String(args.key || '').length, fields: [], ttl: -1 })
      }
      if (op === 'delKeys') {
        const n = window.__delCalls.length + 1
        window.__delCalls.push(JSON.parse(JSON.stringify(args)))
        return new Promise((resolve, reject) => setTimeout(() => {
          if (n === window.__failAt) {
            reject(new Error('NOPERM this user has no permissions to run unlink'))
            return
          }
          const want = new Set(args.keys || [])
          const before = window.__keys.length
          window.__keys = window.__keys.filter(k => !want.has(k))
          resolve(before - window.__keys.length)
        }, window.__delay || 0))
      }
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name === 'closeDbTab') return Promise.resolve(null)
    return Promise.resolve(null)
  }
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  // 多个 db tab 并存时（production/只读各开一个）必须只认当前会话，
  // 否则 __keyRows/__bar 会取到隐藏 tab 里的那一套，勾选和按钮永远对不上
  window.__scope = () => document.querySelector('.session-current') || document
  window.__in = (root, sel) => [...root.querySelectorAll(sel)].filter(window.__vis)
  // 全局：弹层挂在 body 的 portal 里，不在会话节点内
  window.__one = sel => window.__in(document, sel)[0] || null
  // 会话内：键列表/工具行/分页条这些每个 db tab 各一份，必须限定当前会话
  window.__sone = sel => window.__in(window.__scope(), sel)[0] || null
  window.__norm = s => String(s || '').replace(/\\s+/g, '')
  window.__clickDb = name => {
    const all = [...document.querySelectorAll('.db-tree-db-name')]
    // 切 tab 后 .session-current 要等一帧才落到新会话上；先找可见的，
    // 找不到就退回任意一个（隐藏 tab 里的节点照样能派发 click，React 不看 CSS）
    const el = all.filter(window.__vis).find(x => x.innerText.trim() === name) ||
      all.find(x => x.innerText.trim() === name)
    if (!el) return 'missing'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__treeReady = () => document.querySelectorAll('.session-current .db-tree-db-name').length > 0
  window.__bar = () => window.__sone('.db-redis-bar')
  window.__inBar = sel => {
    const b = window.__bar()
    return b ? [...b.querySelectorAll(sel)].filter(window.__vis) : []
  }
  window.__delBtn = () => window.__inBar('button')
    .find(b => /^(删除选中|delete selected)/i.test(window.__norm(b.innerText))) || null
  window.__delBtnState = () => {
    const b = window.__delBtn()
    return b ? { text: window.__norm(b.innerText), disabled: !!b.disabled } : null
  }
  window.__clickDelBtn = () => {
    const b = window.__delBtn()
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__chip = () => {
    const c = window.__sone('.db-redis-sel-chip')
    return c ? window.__norm(c.innerText) : null
  }
  window.__clearSel = () => {
    const b = window.__sone('.db-redis-sel-clear')
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  // 行虚拟渲染（virtual=true）下体表不是 <tr>：antd 用 div.ant-table-row
  window.__keyRows = () => [...window.__scope().querySelectorAll('.db-redis-keys .ant-table-tbody div.ant-table-row')]
  window.__rowNames = () => window.__keyRows().map(tr => {
    const cells = tr.querySelectorAll('.ant-table-cell')
    // 第一格是勾选框，键名在第二格
    return (cells[1] ? cells[1].innerText : '').trim()
  })
  window.__rowBox = i => {
    const tr = window.__keyRows()[i]
    const w = tr && tr.querySelector('.ant-checkbox-wrapper')
    if (!w) return 'missing'
    w.click()
    return 'ok'
  }
  window.__headBox = () => {
    const sels = ['.db-redis-keys .ant-table-header .ant-checkbox-wrapper',
      '.db-redis-keys .ant-table-thead .ant-checkbox-wrapper']
    for (const s of sels) {
      const w = window.__sone(s)
      if (w) { w.click(); return 'ok' }
    }
    return 'missing'
  }
  window.__boxDisabled = () => {
    const tr = window.__keyRows()[0]
    const inp = tr && tr.querySelector('.ant-checkbox-input')
    return inp ? !!inp.disabled : null
  }
  // 分页条里还有"跳转"按钮，不能按位置取（最后一个是 Go）
  window.__pagerBtn = dir => [...window.__scope().querySelectorAll('.db-grid-pager button')]
    .filter(window.__vis)
    .find(b => b.querySelector(dir === 'prev' ? '.anticon-left' : '.anticon-right')) || null
  window.__pagerStep = dir => {
    const b = window.__pagerBtn(dir)
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__pagerNext = () => window.__pagerStep('next')
  window.__pagerPrev = () => window.__pagerStep('prev')
  window.__fonts = () => {
    const a = window.__one('.db-redis-del-list')
    const b = window.__one('.db-redis-keys')
    return {
      del: a ? getComputedStyle(a).fontFamily : null,
      keys: b ? getComputedStyle(b).fontFamily : null
    }
  }
  window.__pageNo = () => {
    const s = window.__sone('.db-grid-page-no')
    return s ? window.__norm(s.innerText) : null
  }
  // 键列表详情：选中键后底部会渲染 .db-redis-detail（值面板/空态都用这个根）
  window.__detail = () => {
    const d = window.__sone('.db-redis-detail')
    if (!d) return null
    return { text: (d.innerText || '').trim(), empty: d.className.indexOf('db-redis-detail-empty') > -1 }
  }
  window.__clickRow = i => {
    const tr = window.__keyRows()[i]
    if (!tr) return 'missing'
    tr.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__m = () => window.__one('.db-redis-del')
  window.__mTitle = () => {
    const t = window.__one('.db-redis-del-modal .ant-modal-title')
    return t ? window.__norm(t.innerText) : null
  }
  window.__mKeys = () => [...document.querySelectorAll('.db-redis-del-key')]
    .filter(window.__vis).map(e => (e.textContent || '').trim())
  window.__mMore = () => {
    const e = window.__one('.db-redis-del-more')
    return e ? window.__norm(e.innerText) : null
  }
  window.__mNote = () => {
    const e = window.__one('.db-redis-del-note')
    return e ? (e.innerText || '').trim() : null
  }
  window.__mProg = () => {
    const e = window.__one('.db-redis-del-prog-text')
    return e ? window.__norm(e.innerText) : null
  }
  window.__mErr = () => {
    const e = window.__one('.db-redis-del-err')
    return e ? (e.innerText || '').trim() : null
  }
  window.__mFoot = () => [...document.querySelectorAll('.db-redis-del-modal .ant-modal-footer button')]
    .filter(window.__vis).map(b => ({ t: window.__norm(b.innerText), disabled: !!b.disabled }))
  window.__mClick = re => {
    const rx = new RegExp(re, 'i')
    const b = [...document.querySelectorAll('.db-redis-del-modal .ant-modal-footer button')]
      .filter(window.__vis).find(x => rx.test(window.__norm(x.innerText)))
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__mKeyColor = () => {
    const e = window.__one('.db-redis-del-key')
    return e ? getComputedStyle(e).color : null
  }
  window.__risk = () => {
    const m = window.__one('.db-risk-modal')
    return m ? (m.innerText || '') : null
  }
  window.__riskCancel = () => {
    const b = [...document.querySelectorAll('.db-risk-modal .ant-modal-footer button')]
      .filter(window.__vis)[0]
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__toast = () => document.body.innerText.indexOf('已删除') > -1 ||
    /deleted \\d+ key/i.test(document.body.innerText)
  return 'stubbed'
})()
`

const openTab = opts => `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis 127.0.0.1:6379',
    dbType: 'redis',
    dbHost: '127.0.0.1',
    dbPort: 6379,
    dbPassword: '',
    dbName: '0',
    dbSsl: false,
    readOnly: ${opts.readOnly ? 'true' : 'false'},
    production: ${opts.production ? 'true' : 'false'},
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null })
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  // 窗口大小由窗管决定（实机常被拉满 2559px），截图和判据都会被拉散；
  // 统一钉成 1600×950 的 CSS 视口，跟其它批次截图同尺度
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false
  })
  // 硬刷：db-session 是懒加载 chunk，不 reload 会在旧 chunk 上跑
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1200)

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async f => {
    // 弹层开场有 zoom+fade 动画（约 200ms），贴着形态断言截图会截到半透明的中间帧
    await sleep(400)
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) throw new Error('screenshot failed')
    fs.writeFileSync(path.join(SHOT_DIR, f), Buffer.from(data, 'base64'))
    console.log('shot -> ' + f)
  }

  // SCAN 翻页是异步的：点完必须等页码真的变了再勾选，
  // 否则勾选框还在上一页的 DOM 上（全选会勾到已经翻走的那页）
  const stepPage = async (dir, label) => {
    const before = JSON.stringify(await cdp.eval('window.__pageNo()'))
    const r = await cdp.eval('window.__pager' + (dir === 'next' ? 'Next' : 'Prev') + '()')
    if (r !== 'ok') {
      check(label, false, r)
      return false
    }
    const ok = await waitFor(cdp, 'window.__pageNo() !== ' + before, label)
    await sleep(400)
    return ok
  }

  await cdp.eval(STUB)
  await clearDbTabs(cdp)
  // 每页 200：默认 20 时"跨页选 600 个"要点 30 次下一页
  await cdp.eval('window.store.setConfig({ dbPageSize: ' + PAGE + ' })')
  await sleep(300)

  const openKeys = async label => {
    const ready = await waitFor(cdp, 'window.__treeReady()', label + ' 树就绪', 30000)
    const r = await cdp.eval("window.__clickDb('db0')")
    check(label + '：点开 db0', ready && r === 'ok', r)
    return waitFor(cdp, 'window.__keyRows().length >= 10', label + ' 键列表', 30000)
  }

  const tab = JSON.parse(await cdp.eval(openTab({ readOnly: false })))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tab.id), 'redis tab active')
  await openKeys('主流程')
  await waitFor(cdp, 'window.__pageNo() !== null', 'pager rendered')

  // ── 1. 空勾选：入口不可点 ───────────────────────────────────────
  const s0 = JSON.parse(await cdp.eval('JSON.stringify(window.__delBtnState())'))
  check('未勾选时删除入口禁用、文案不带数字',
    s0 && s0.disabled === true && !/\(\d+\)/.test(s0.text), s0)
  check('工具行没有"已选"提示', (await cdp.eval('window.__chip()')) === null)

  // ── 2. 勾两个：按钮带数字，取消 = 零调用 ────────────────────────
  const names = JSON.parse(await cdp.eval('JSON.stringify(window.__rowNames())'))
  await cdp.eval('window.__clickRow(0)')
  await waitFor(cdp, 'window.__detail() && !window.__detail().empty', 'key detail rendered')
  await cdp.eval('window.__rowBox(0)')
  await cdp.eval('window.__rowBox(1)')
  await sleep(200)
  const s1 = JSON.parse(await cdp.eval('JSON.stringify(window.__delBtnState())'))
  check('勾选后入口可用，按钮带选中数',
    s1 && s1.disabled === false && s1.text.indexOf('(2)') > -1, s1)
  check('工具行常驻"已选 2 个键"',
    /^已选2个键|^selected2/i.test(String(await cdp.eval('window.__chip()'))), await cdp.eval('window.__chip()'))

  await cdp.eval('window.__clickDelBtn()')
  await waitFor(cdp, '!!window.__m()', 'modal open')
  const title = await cdp.eval('window.__mTitle()')
  const note = await cdp.eval('window.__mNote()')
  const keysInModal = JSON.parse(await cdp.eval('JSON.stringify(window.__mKeys())'))
  check('弹层标题带数量', /2/.test(String(title)), title)
  check('正文说明走 UNLINK（不是 DEL）', /UNLINK/.test(String(note)), note)
  check('预览列出这两个键、顺序与列表一致',
    keysInModal.length === 2 && keysInModal[0] === names[0] && keysInModal[1] === names[1], keysInModal)
  check('未开始删除时不显示进度条', (await cdp.eval('window.__mProg()')) === null)
  const foot0 = JSON.parse(await cdp.eval('JSON.stringify(window.__mFoot())'))
  check('弹层两个按钮都能点（未运行）',
    foot0.length === 2 && foot0.every(b => !b.disabled), foot0)

  await shot('1-preview-dark.png')

  await cdp.eval('window.__mClick("^(取消|cancel)$")')
  await waitFor(cdp, '!window.__m()', 'modal closed by cancel')
  check('取消 = 零调用（一次 delKeys 都不发）',
    (await cdp.eval('window.__delCalls.length')) === 0)

  // ── 3. 小批删除：1 个键、详情跟着清 ─────────────────────────────
  // 取消后两个都还勾着；去掉 names[1]，再把详情点回 names[0]——
  // 要验的是"被删的那个键的详情会一起清掉"，详情停在别人身上就验不到了
  await cdp.eval('window.__rowBox(1)')
  await sleep(150)
  await cdp.eval('window.__clickRow(0)')
  await waitFor(cdp, 'window.__detail() && !window.__detail().empty', 'detail back to names[0]')
  await cdp.eval('window.__clickDelBtn()')
  await waitFor(cdp, '!!window.__m()', 'modal open 1')
  await cdp.eval('window.__mClick("^(删除选中|delete selected)")')
  await waitFor(cdp, '!window.__m()', 'modal closed after delete')
  const d1 = JSON.parse(await cdp.eval('JSON.stringify(window.__delCalls)'))
  check('单批删除：一次调用、键数 1、只带 dbIndex+keys（readOnly 归主进程）',
    d1.length === 1 && d1[0].keys.length === 1 && d1[0].dbIndex === 0 && !('readOnly' in d1[0]), d1)
  check('删掉的是勾选的那个键（取消后只剩 names[0]）',
    d1.length === 1 && d1[0].keys[0] === names[0], d1[0] && d1[0].keys)
  await waitFor(cdp, 'window.__keys.length === ' + (KEY_COUNT - 1), 'stub key removed')
  await waitFor(cdp, 'window.__chip() === null', 'selection cleared')
  check('删完清空勾选、按钮回到禁用', JSON.parse(await cdp.eval('JSON.stringify(window.__delBtnState())')).disabled === true)
  const detail = JSON.parse(await cdp.eval('JSON.stringify(window.__detail())'))
  check('被删键的详情一起清掉（不留一个已不存在的键）', detail && detail.empty === true, detail)
  check('成功后提示已删除', (await cdp.eval('window.__toast()')) === true)

  // ── 4. 跨页选 600：分批 500 + 100，进度按实际删除数 ─────────────
  await cdp.eval('window.__headBox()')
  await sleep(200)
  check('本页全选 200', /200/.test(String(await cdp.eval('window.__chip()'))), await cdp.eval('window.__chip()'))
  await stepPage('next', 'page 2')
  await cdp.eval('window.__headBox()')
  await sleep(200)
  await stepPage('next', 'page 3')
  await cdp.eval('window.__headBox()')
  await sleep(300)
  const chip3 = String(await cdp.eval('window.__chip()'))
  check('跨页勾选累积到 600（翻页不清勾选）', /600/.test(chip3), chip3)

  const gd0 = await cdp.eval("window.__count('getPageData')")
  const gm0 = await cdp.eval("window.__count('getMetadata')")
  await cdp.eval('window.__clickDelBtn()')
  await waitFor(cdp, '!!window.__m()', 'modal open 600')
  const more = await cdp.eval('window.__mMore()')
  const keys600 = JSON.parse(await cdp.eval('JSON.stringify(window.__mKeys())'))
  check('预览只列 20 个键 + "另有 580 个键未列出"',
    keys600.length === 20 && /580/.test(String(more)), { n: keys600.length, more })
  await shot('2-preview-truncated-dark.png')

  // 放慢每一批，才看得见进行中的进度条
  await cdp.eval('window.__delay = 700')
  await cdp.eval('window.__delCalls = []')
  await cdp.eval('window.__mClick("^(删除选中|delete selected)")')
  await sleep(350)
  const mid = JSON.parse(await cdp.eval('JSON.stringify({ prog: window.__mProg(), foot: window.__mFoot() })'))
  check('删除中：进行中的弹层不能取消（已发出的 UNLINK 收不回来）',
    mid.prog !== null && mid.foot.some(b => b.t === '取消' || b.t === 'cancel') &&
    mid.foot.filter(b => /^(取消|cancel)$/i.test(b.t)).every(b => b.disabled), mid)
  await shot('3-progress-dark.png')
  await waitFor(cdp, '!window.__m()', 'modal closed after 600', 12000)
  const d600 = JSON.parse(await cdp.eval('JSON.stringify(window.__delCalls)'))
  check('600 个键分两批：500 + 100（每批 ≤ 500）',
    d600.length === 2 && d600[0].keys.length === 500 && d600[1].keys.length === 100,
    d600.map(c => c.keys.length))
  check('两批都带同一个 dbIndex、都不带 readOnly',
    d600.every(c => c.dbIndex === 0 && !('readOnly' in c)))
  await waitFor(cdp, 'window.__keys.length === ' + (KEY_COUNT - 601), 'stub 600 removed')
  check('假库实际删掉 600 个键', (await cdp.eval('window.__keys.length')) === KEY_COUNT - 601)
  check('删完清空勾选', (await cdp.eval('window.__chip()')) === null)
  // 原页重拉（不是回第一页）+ 左侧键数刷新
  await waitFor(cdp, 'window.__count("getPageData") > ' + gd0, 'list reloaded')
  const lastPageCall = await cdp.eval("window.__calls.filter(c => c.indexOf('getPageData') === 0).pop()")
  check('原页重拉：游标仍是刚才那页的起点，不回第一页',
    /"cursor":"400"/.test(String(lastPageCall)), lastPageCall)
  check('左侧键数同步刷新（getMetadata 重发）',
    (await cdp.eval("window.__count('getMetadata')")) > gm0)

  // ── 5. 中途失败：停在弹层，不重试 ───────────────────────────────
  // 上一节停在原页（第 3 页，栈里还有两层）；回第一页再选满 3 页，
  // 剩 599 个键 → 两批 500 + 99，第 2 批失败才有"删了一半"的样子
  await stepPage('prev', 'back to page 2')
  await stepPage('prev', 'back to page 1')
  await cdp.eval('window.__headBox()')
  await sleep(250)
  await stepPage('next', 'page 2 again')
  await cdp.eval('window.__headBox()')
  await sleep(250)
  await stepPage('next', 'page 3 again')
  await cdp.eval('window.__headBox()')
  await sleep(300)
  const chipFail = String(await cdp.eval('window.__chip()'))
  check('回到第一页重新选满 3 页（599 个键）', /599/.test(chipFail), chipFail)
  await cdp.eval('window.__delay = 250')
  await cdp.eval('window.__delCalls = []')
  await cdp.eval('window.__failAt = 2')
  await cdp.eval('window.__clickDelBtn()')
  await waitFor(cdp, '!!window.__m()', 'modal open fail')
  await cdp.eval('window.__mClick("^(删除选中|delete selected)")')
  await waitFor(cdp, '!!window.__mErr()', 'error shown', 12000)
  const err = JSON.parse(await cdp.eval('JSON.stringify({ err: window.__mErr(), prog: window.__mProg(), foot: window.__mFoot() })'))
  const failCalls = JSON.parse(await cdp.eval('JSON.stringify(window.__delCalls.map(c => c.keys.length))'))
  check('失败前的 500 个已经删掉、失败后不再发第 3 批',
    failCalls.length === 2 && failCalls[0] === 500 && failCalls[1] === 99, { chipFail, failCalls })
  check('红条带原始报错 + "已删除 500 / 599 后中止"',
    /NOPERM/.test(err.err) && /500/.test(err.prog || '') && /599/.test(err.prog || ''), err)
  check('失败后只剩"关闭"，不给重试（重发已删键会让进度从 0 重来）',
    err.foot.length === 1 && /^(关闭|close)$/i.test(err.foot[0].t), err.foot)
  check('失败时弹层还开着', (await cdp.eval('!!window.__m()')) === true)
  await shot('4-error-dark.png')
  await cdp.eval('window.__mClick("^(关闭|close)$")')
  await waitFor(cdp, '!window.__m()', 'closed after error')
  check('假库只少了 500 个键（失败的这批一个都没删）',
    (await cdp.eval('window.__keys.length')) === KEY_COUNT - 601 - 500)

  // ── 6. production：多一次 E1 风险确认，取消仍零调用 ─────────────
  await cdp.eval('window.__failAt = -1')
  await cdp.eval('window.__delay = 0')
  await clearDbTabs(cdp)
  const tabP = JSON.parse(await cdp.eval(openTab({ readOnly: false, production: true })))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tabP.id), 'production tab active')
  await openKeys('production')
  await cdp.eval('window.__rowBox(0)')
  await sleep(200)
  const beforeRisk = await cdp.eval('window.__delCalls.length')
  await cdp.eval('window.__clickDelBtn()')
  await waitFor(cdp, '!!window.__m()', 'modal open prod')
  await cdp.eval('window.__mClick("^(删除选中|delete selected)")')
  await waitFor(cdp, '!!window.__risk()', 'risk gate shown', 10000)
  const risk = String(await cdp.eval('window.__risk()'))
  check('production 走 E1：风险确认里带 UNLINK 命令文本', /UNLINK/.test(risk), risk.slice(0, 120))
  await cdp.eval('window.__riskCancel()')
  await waitFor(cdp, '!!window.__risk() === false', 'risk dismissed')
  await sleep(300)
  check('风险确认取消 = 零调用，删键弹层还停在预览',
    (await cdp.eval('window.__delCalls.length')) === beforeRisk && (await cdp.eval('!!window.__m()')) === true)
  await cdp.eval('window.__mClick("^(取消|cancel)$")')
  await waitFor(cdp, '!window.__m()', 'prod modal closed')

  // ── 7. 只读：复选框与入口都禁用 ─────────────────────────────────
  await clearDbTabs(cdp)
  const tabR = JSON.parse(await cdp.eval(openTab({ readOnly: true })))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tabR.id), 'readonly tab active')
  await openKeys('只读')
  check('只读：行复选框禁用', (await cdp.eval('window.__boxDisabled()')) === true)
  await cdp.eval('window.__headBox()')
  await sleep(200)
  check('只读：点全选也选不中', (await cdp.eval('window.__chip()')) === null)
  const roBtn = JSON.parse(await cdp.eval('JSON.stringify(window.__delBtnState())'))
  check('只读：删除入口禁用', roBtn && roBtn.disabled === true, roBtn)

  // ── 8. 等宽字体链 + 浅色主题换色 ────────────────────────────────
  const theme0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== theme0)
  if (lightId) {
    // 回到可写 tab 才能开弹层
    await clearDbTabs(cdp)
    const tabL = JSON.parse(await cdp.eval(openTab({ readOnly: false })))
    await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tabL.id), 'tab active light')
    await openKeys('浅色')
    await cdp.eval('window.__rowBox(0)')
    await cdp.eval('window.__rowBox(1)')
    await sleep(200)
    await cdp.eval('window.__clickDelBtn()')
    await waitFor(cdp, '!!window.__m()', 'modal dark')
    const fonts = JSON.parse(await cdp.eval('JSON.stringify(window.__fonts())'))
    // 弹层在 body 的 portal 里，拿不到 tab 上传下来的 --db-code-font，
    // 落到同一套回落链的 --font-mono —— 两边都必须是等宽，不能是 UI 正文字体
    check('键名列表用 tab 字体、弹层预览落到等宽回落链（都不是 UI 正文字体）',
      !!fonts.del && /mono/i.test(fonts.del) && !!fonts.keys && /mono/i.test(fonts.keys), fonts)
    const darkColor = await cdp.eval('window.__mKeyColor()')
    await shot('5-preview-selection-dark.png')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(900)
    const lightColor = await cdp.eval('window.__mKeyColor()')
    check('浅色主题下键名颜色跟着变（不是写死色）',
      !!lightColor && lightColor !== darkColor, { darkColor, lightColor })
    await shot('6-preview-light.png')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
    await sleep(500)
    await cdp.eval('window.__mClick("^(取消|cancel)$")')
    await sleep(200)
  } else {
    check('存在可切换的浅色系主题', false, themeIds)
  }

  const cleared = await clearDbTabs(cdp)
  check('自测收尾关闭数据库 tab', cleared.left.length === 0, cleared)

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
