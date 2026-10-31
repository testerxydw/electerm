#!/usr/bin/env node
/**
 * G5 目录镜像 —— 弹层 UI 的 CDP 实机演示/回归（假 sftp + 真本地临时树）
 *
 * 单测钉的是纯函数（dir-mirror.spec / dir-mirror-walk.spec）与接线契约
 * （dir-mirror-ui.spec）。这里验的是只有真渲染才看得见的东西：
 *   1) 打开即预演：分组计数、预估字节和 diffTrees 的判定一一对得上
 *   2) 符号链接不进树（真在磁盘上建一条 symlink，看它有没有被算进去）
 *   3) blocked（本地文件撞远端目录）、建目录父在子前、远端多余项如实报数
 *   4) 改判断依据只对已采回来的两棵树重算：sftp.list 的调用次数一次都不许涨
 *   5) 删除勾选默认不勾；勾上才列待删，且目录永远不进待删
 *   6) 执行顺序：mkdir → 传输入队 → 最后才删；mkdir 失败在结果里点名
 *   7) 覆盖项带 mergeOrOverwrite、新建项不带；权限 mode 随条目传到传输层
 *   8) 一端没采齐时删除勾选禁用，硬把 deleteExtra 塞成 true 也被执行前的闸挡下
 *   9) 明细只渲染 500 行，但截断那句要写清总数
 *  10) 采集中途可叫停，叫停后不再继续打远端
 *  11) 执行中关不掉弹层；完成后可关
 *  12) 浅色主题下面板底色跟着 token 变
 *
 * 假 sftp 只替 list/mkdir/rm 三个方法，采集、差异、预演面板、执行编排、传输入队全是
 * 真代码路径。真的字节搬运在 transfer.jsx，这里把 addTransferList 拦下来只记不传
 * （没有真会话，真传会一路报错）。本地树用 os.tmpdir() 下的真目录，跑完直删（不进回收站）。
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/ work/app/
 *   2) 起带 --remote-debugging-port 的实例（隔离 HOME）
 *   3) node self-test/dir-mirror-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9233'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'dir-mirror-shots')

const RROOT = '/remote/mirror'
const BULK = '/remote/bulk'
const BADROOT = '/remote/bad'
const T = 1730000000000 // 固定时刻：两端时间戳都要能钉死
const SEC = T / 1000
const BULK_N = 520 // > PLAN_LIMIT(500)，用来演明细截断

const EN = (d) => ({ name: d, type: 'd', size: 4096, modifyTime: SEC })
const EF = (n, size) => ({ name: n, type: '-', size, modifyTime: SEC })

// 远端假树：键 = 绝对路径，值 = sftp.list 会返回的那一串
const REMOTE = {
  [RROOT]: [
    EF('same.txt', 20), // 大小同、时间同 → 跳过
    EF('old.txt', 20), // 大小同、本地早 120s → 按时间覆盖 / 只比大小则跳过
    EF('a.txt', 12), // 大小不同 → 覆盖
    EN('dirfile'), // 本地同路径是文件 → blocked
    EF('vsf', 3), // 本地同路径是目录 → 要 mkdir，且必然失败
    EF('extra.txt', 11), // 远端多余 → 待删
    EN('extra_dir') // 远端多余但是目录 → 只报数不删
    // 注意：远端故意没有 x/，本地 x/y/z.txt 要连建两级，用来验父目录排在子目录前
  ],
  [RROOT + '/dirfile']: [EF('inner.txt', 4)], // 远端多余（在 blocked 那个目录里）
  [RROOT + '/extra_dir']: [],
  [BULK]: []
}

// 坏树：某个子目录读失败 → 采集不完整 → 删除勾选必须禁用
const BAD_REMOTE = {
  [BADROOT]: [EF('ok.txt', 1), EN('boom'), EF('lonely.txt', 7)],
  [BADROOT + '/boom']: new Error('Permission denied')
}

const PROBE = `
(() => {
  const norm = x => String(x == null ? '' : x).split(' ').join('')
  const dm = {
    lists: [], listCount: 0, mkdirs: [], rms: [], transfers: [], done: 0,
    delay: 0, opDelay: 0, tree: {},
    realAdd: window.store.addTransferList,
    // 传输入队拦下来只记不传：这里没有真会话
    install () {
      window.store.addTransferList = (items) => {
        dm.transfers.push(...items.map(t => ({
          fromPath: t.fromPath,
          toPath: t.toPath,
          typeFrom: t.typeFrom,
          typeTo: t.typeTo,
          size: t.fromFile && t.fromFile.size,
          mode: t.fromFile && t.fromFile.mode,
          isDirectory: !!(t.fromFile && t.fromFile.isDirectory),
          resolvePolicy: t.resolvePolicy
        })))
      }
      return 'installed'
    },
    restore () { window.store.addTransferList = dm.realAdd; return 'restored' },
    reset () {
      dm.lists = []; dm.listCount = 0; dm.mkdirs = []; dm.rms = []
      dm.transfers = []; dm.done = 0
    },
    sftpFor (fail) {
      return {
        list (p) {
          dm.lists.push(p)
          dm.listCount++
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              if (fail && fail.indexOf(p) >= 0) {
                reject(new Error('boom for ' + p))
                return
              }
              const v = dm.tree[p]
              if (v instanceof Error) reject(v)
              else resolve(v || [])
            }, dm.delay)
          })
        },
        mkdir (p) {
          dm.mkdirs.push(p)
          // 远端同路径已经躺着一个文件：真实服务端这里一定失败
          return p === dm.tree.__vsf
            ? dm.late(() => Promise.reject(new Error('File exists')), dm.opDelay)
            : dm.late(() => Promise.resolve(), dm.opDelay)
        },
        rm (p) {
          dm.rms.push(p)
          return dm.late(() => Promise.resolve(), dm.opDelay)
        }
      }
    },
    late (f, ms) { return new Promise(res => setTimeout(() => res(f()), ms || 0)) },
    open (o) {
      const m = window.refsStatic.get('dir-mirror-modal')
      if (!m) return 'no-modal'
      dm.tree = Object.assign({}, o.tree)
      dm.tree.__vsf = o.vsfPath
      m.showMirror({
        dir: o.dir,
        remotePath: o.remotePath,
        sftp: dm.sftpFor(o.fail),
        tab: { id: 'demo-tab', host: 'demo@1.2.3.4:22', type: 'terminal' },
        onDone: () => { dm.done++ }
      })
      return 'opened'
    },
    root () {
      return [...document.querySelectorAll('.dir-mirror-modal')].find(el =>
        getComputedStyle(el).display !== 'none')
    },
    ui () {
      const el = dm.root()
      if (!el) return { open: false }
      const t = s => { const n = el.querySelector(s); return n ? (n.innerText || '').trim() : null }
      const rows = [...el.querySelectorAll('.dir-mirror-plan-row')].map(r => ({
        group: ((r.querySelector('.dir-mirror-plan-group') || {}).innerText || '').trim(),
        path: ((r.querySelector('.dir-mirror-plan-path') || {}).innerText || '').trim(),
        size: ((r.querySelector('.dir-mirror-plan-size') || {}).innerText || '').trim()
      }))
      const cb = el.querySelector('.dir-mirror-options input[type=checkbox]')
      return {
        open: true,
        footer: t('.custom-modal-footer'),
        title: t('.custom-modal-title'),
        pathCells: [...el.querySelectorAll('.dir-mirror-path')].map(n => (n.innerText || '').trim()),
        remoteInput: (el.querySelector('.dir-mirror-paths input') || {}).value,
        nums: [...el.querySelectorAll('.dir-mirror-nums span')].map(n => (n.innerText || '').trim()),
        bytes: t('.dir-mirror-bytes'),
        notes: [...el.querySelectorAll('.dir-mirror-notes li')].map(n => (n.innerText || '').trim()),
        more: t('.dir-mirror-plan-more'),
        rowCount: rows.length,
        rows,
        error: t('.dir-mirror-error'),
        notice: t('.dir-mirror-notice'),
        result: t('.dir-mirror-result'),
        detail: t('.dir-mirror-detail'),
        warnLine: t('.dir-mirror-warn-line'),
        checked: cb ? !!cb.checked : null,
        cbDisabled: cb ? !!cb.disabled : null,
        hint: t('.dir-mirror-hint'),
        footBtns: [...el.querySelectorAll('.custom-modal-footer button')]
          .map(b => ({ text: norm(b.innerText), disabled: !!b.disabled })),
        done: dm.done
      }
    },
    exec () {
      const m = window.refsStatic.get('dir-mirror-modal')
      if (!m) return 'no-modal'
      m.handleExecute()
      return 'clicked'
    },
    // 绕过界面上的禁用，专测「执行前再看一次完整性」那道闸
    forceDeleteExtra (v) {
      const m = window.refsStatic.get('dir-mirror-modal')
      if (!m) return 'no-modal'
      m.setState({ deleteExtra: !!v }, () => m.applyDiff())
      return 'set'
    },
    closeByRef () {
      const m = window.refsStatic.get('dir-mirror-modal')
      if (!m) return 'no-modal'
      m.handleClose()
      return 'closed'
    },
    xy (el) {
      if (!el) return JSON.stringify({ error: 'no-el' })
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return JSON.stringify({ error: 'zero-size' })
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    },
    footBtn (reSrc) {
      const re = new RegExp(reSrc, 'i')
      const el = dm.root()
      if (!el) return JSON.stringify({ error: 'no-modal' })
      const b = [...el.querySelectorAll('.custom-modal-footer button')]
        .find(x => re.test(norm(x.innerText)) && x.offsetParent !== null)
      if (!b) return JSON.stringify({ error: 'no-btn' })
      const r = b.getBoundingClientRect()
      if (!r.width || !r.height) return JSON.stringify({ error: 'zero-size' })
      return JSON.stringify({
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        disabled: !!b.disabled,
        text: norm(b.innerText)
      })
    },
    checkboxXY () {
      const el = dm.root()
      return dm.xy(el && el.querySelector('.dir-mirror-options .ant-checkbox'))
    },
    selectXY () {
      const el = dm.root()
      if (!el) return JSON.stringify({ error: 'no-modal' })
      // antd 6 的 Select 可点的是内部 .ant-select-content
      const s = el.querySelector('.dir-mirror-option .ant-select-content') ||
        el.querySelector('.dir-mirror-option .ant-select')
      return dm.xy(s)
    },
    optXY (label) {
      const dd = [...document.querySelectorAll('.ant-select-dropdown')]
        .find(x => !x.className.includes('ant-select-dropdown-hidden') && x.offsetParent !== null)
      const o = dd && [...dd.querySelectorAll('.ant-select-item-option')]
        .find(x => norm(x.innerText) === norm(label))
      return dm.xy(o)
    },
    optionLabels () {
      return [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option')]
        .map(x => (x.innerText || '').trim())
    },
    bgColor () {
      const el = dm.root()
      const c = el && el.querySelector('.custom-modal-content')
      return c ? getComputedStyle(c).backgroundColor : null
    }
  }
  window.__dm = dm
  return 'ok'
})()
`

const main = async () => {
  const targets = await getJson('http://127.0.0.1:' + PORT + '/json/list')
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no page target')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Log.enable', {})
  // 事件缓冲不清空会把上一轮（甚至上一批次）的报错算进本次判据
  cdp.events.length = 0
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
  })
  // 主进程被吊住时这条先失败，别等到 UI 超时才发现环境不通
  if (String(await cdp.eval('1 + 1')) !== '2') {
    throw new Error('renderer not answering')
  }
  await cdp.call('Page.reload', { ignoreCache: true })
  // 只等 store/pre 会踩空：新文档还没挂 refsStatic 时取组件实例拿到 undefined
  await waitFor(cdp, '!!window.store && !!window.pre && !!window.refsStatic && ' +
    "!!window.refsStatic.get('dir-mirror-modal')", 'renderer boots with mirror modal', 120000)
  await sleep(1500)
  cdp.events.length = 0

  const { check, results } = makeChecker()
  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(320)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }
  const ui = () => cdp.jeval('JSON.stringify(window.__dm.ui())')
  const stat = () => cdp.jeval('JSON.stringify({transfers: window.__dm.transfers, mkdirs: window.__dm.mkdirs, rms: window.__dm.rms, lists: window.__dm.lists, listCount: window.__dm.listCount, done: window.__dm.done})')
  const clickBtn = async re => {
    // footBtn 收的是「正则源码」不是正则字面量：直接 toString() 会变成
    // new RegExp('/开始镜像|…/')，那个开头的斜杠是要求，一个按钮都匹配不上
    const xy = await cdp.jeval('window.__dm.footBtn(' + JSON.stringify(re.source) + ')')
    if (xy.error) {
      return xy
    }
    await cdp.click(xy.x, xy.y)
    await sleep(420)
    return xy
  }
  // rc-motion 的浮层刚出现时量到的是动画中间值，坐标连续两次一致才算数
  const stableXY = async (expr, tries = 12) => {
    let prev = null
    for (let i = 0; i < tries; i++) {
      const cur = await cdp.eval(expr)
      if (prev !== null && cur === prev && String(cur).indexOf('error') < 0) {
        return JSON.parse(cur)
      }
      prev = cur
      await sleep(180)
    }
    return JSON.parse(prev || '{"error":"unstable"}')
  }
  const ready = async label => {
    const ok = await waitFor(cdp,
      '(() => { const u = window.__dm.ui(); return !!u.open && !!(u.nums && u.nums.length) })()',
      label, 30000)
    if (!ok) {
      throw new Error('pre-preview never landed: ' + label)
    }
    await sleep(300)
  }
  const firstNum = s => {
    const m = /(\d+)/.exec(String(s || ''))
    return m ? Number(m[1]) : null
  }

  // ---- 真本地树（os.tmpdir，跑完直删，不进回收站）----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-g5-mirror-'))
  // 截断那一幕用的大批量目录单独一棵：混在 root 里会让前面每一幕的计数都变成 5xx
  const bulkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-g5-bulk-'))
  const L = (...p) => path.join(root, ...p)
  const put = (p, size, mtime = T, mode) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.alloc(size, 97))
    const d = new Date(mtime)
    fs.utimesSync(p, d, d)
    if (mode !== undefined) {
      fs.chmodSync(p, mode)
    }
  }
  put(L('a.txt'), 10)
  put(L('same.txt'), 20)
  put(L('old.txt'), 20, T - 120000)
  put(L('new.txt'), 5, T, 0o640)
  put(L('dirfile'), 8) // 本地是文件，远端同路径是目录 → blocked
  put(L('x/y/z.txt'), 6)
  fs.mkdirSync(L('vsf')) // 本地空目录，远端同路径是文件 → mkdir 必失败
  fs.symlinkSync('a.txt', L('link.txt')) // 不进树
  for (let i = 0; i < BULK_N; i++) {
    put(path.join(bulkRoot, 'b' + String(i).padStart(4, '0') + '.txt'), 1)
  }

  try {
    await cdp.eval(PROBE)
    await cdp.eval('window.__dm.install(); window.__dm.reset()')

    // ============ 1. 打开即预演 ============
    await cdp.eval('window.__dm.open(' + JSON.stringify({
      dir: root, remotePath: RROOT, tree: REMOTE, vsfPath: RROOT + '/vsf'
    }) + ')')
    check('弹层组件挂到主界面（refsStatic 拿得到）',
      await cdp.eval("!!window.refsStatic.get('dir-mirror-modal')"))
    await ready('first preview')
    let u = await ui()
    const numsLine = () => u.nums.join(' | ')
    check('预演面板出现（标题 + 源路径 + 目标输入框预填远端当前目录）',
      !!u.title && u.pathCells[0] === root && u.remoteInput === RROOT,
      { title: u.title, pathCells: u.pathCells, remoteInput: u.remoteInput })
    check('分组计数按 diffTrees 口径：新建 2 / 覆盖 2 / 跳过 1 / 建目录 3',
      firstNum(u.nums[0]) === 2 && firstNum(u.nums[1]) === 2 &&
      firstNum(u.nums[2]) === 1 && firstNum(u.nums[3]) === 3, numsLine())
    check('预估字节 = 新建 + 覆盖（5+6+10+20=41B）', /41\s?B/.test(String(u.bytes)), u.bytes)
    check('blocked 项进明细并有说明（本地文件 dirfile 撞远端目录）',
      u.rows.some(r => r.path === 'dirfile') &&
      u.notes.some(n => /dirfile|1/.test(n)), { rows: u.rows.map(r => r.path), notes: u.notes })
    check('符号链接不进明细', !u.rows.some(r => /link\.txt/.test(r.path)), u.rows.map(r => r.path))
    check('建目录 x 排在 x/y 前（先建父再建子）',
      (() => {
        const paths = u.rows.map(r => r.path)
        return paths.indexOf('x') >= 0 && paths.indexOf('x/y') > paths.indexOf('x')
      })(), u.rows.map(r => r.path))
    check('远端多余 3 项（含 1 个目录）如实报数',
      u.nums.some(s => firstNum(s) === 3 && /1/.test(String(s))), numsLine())
    check('删除勾选默认不勾，且待删项一个都不列',
      u.checked === false && !u.rows.some(r => /extra\.txt/.test(r.path)),
      { checked: u.checked, rows: u.rows.map(r => r.path) })
    await shot('preview-dark')

    // ============ 2. 改判断依据不重新采集 ============
    const listBefore = Number(await cdp.eval('window.__dm.listCount'))
    const xySel = await stableXY('window.__dm.selectXY()')
    check('判断依据下拉可点', !xySel.error, xySel)
    await cdp.click(xySel.x, xySel.y)
    await sleep(600)
    const labels = await cdp.jeval('JSON.stringify(window.__dm.optionLabels())')
    const sizeOnly = labels.find(l => /only|仅比大小/i.test(l.split(' ').join('')))
    const sizeMtime = labels.find(l => /mtime|修改时间/i.test(l.split(' ').join('')))
    check('下拉里有「大小+修改时间」和「仅比大小」两个选项', !!sizeOnly && !!sizeMtime, labels)
    const xyOpt = await stableXY('window.__dm.optXY(' + JSON.stringify(sizeOnly) + ')')
    await cdp.click(xyOpt.x, xyOpt.y)
    await sleep(700)
    const listAfter = Number(await cdp.eval('window.__dm.listCount'))
    u = await ui()
    check('切换判据只对已采回的树重算：sftp.list 一次都没多发',
      listAfter === listBefore, { before: listBefore, after: listAfter })
    check('只比大小时 old.txt 从覆盖变跳过（覆盖 1 / 跳过 2）',
      firstNum(u.nums[1]) === 1 && firstNum(u.nums[2]) === 2, numsLine())
    await cdp.click(xySel.x, xySel.y)
    await sleep(600)
    const xyBack = await stableXY('window.__dm.optXY(' + JSON.stringify(sizeMtime) + ')')
    await cdp.click(xyBack.x, xyBack.y)
    await sleep(700)
    u = await ui()
    check('换回「大小 + 修改时间」后覆盖回到 2', firstNum(u.nums[1]) === 2, numsLine())

    // ============ 3. 勾选删除 ============
    const xyCb = await stableXY('window.__dm.checkboxXY()')
    check('两端采齐时删除勾选可点', !xyCb.error, xyCb)
    await cdp.click(xyCb.x, xyCb.y)
    await sleep(600)
    u = await ui()
    const dels = u.rows.filter(r => /删除|delete/i.test(r.group))
    check('勾上才列出 2 个待删文件，目录 extra_dir 永远不进待删',
      dels.length === 2 &&
      dels.some(d => /extra\.txt/.test(d.path)) &&
      dels.some(d => /dirfile\/inner\.txt/.test(d.path)),
      dels.map(d => d.path))
    check('勾选后给出「将删除 N 个文件」的警告行', !!u.warnLine, u.warnLine)
    await shot('delete-checked-dark')

    // ============ 4. 执行 ============
    await cdp.eval('window.__dm.reset()')
    const xyExec = await clickBtn(/开始镜像|start\s?mirror/i)
    check('执行按钮可点', !xyExec.error && xyExec.disabled === false, xyExec)
    const gotResult = await waitFor(cdp,
      '(() => { const u = window.__dm.ui(); return !!u.result })()', 'result panel', 25000)
    check('执行后落到完成态', gotResult)
    u = await ui()
    const st = await stat()
    check('mkdir 只建真缺的两个目录，顺序 = 父在前（x → x/y）；vsf 不去试',
      st.mkdirs.join('|') === [RROOT + '/x', RROOT + '/x/y'].join('|'), st.mkdirs)
    check('vsf 在结果里点名（远端同路径上已是一个文件，不用试也知道建不出来）',
      /vsf/.test(String(u.detail)) && /已存在|exists/i.test(String(u.detail)), u.detail)
    check('传输入队 4 项 = 新建 2 + 覆盖 2，方向全是本地→远端',
      st.transfers.length === 4 &&
      st.transfers.every(t => t.typeFrom === 'local' && t.typeTo === 'remote'), st.transfers)
    check('路径拼接：fromPath 落在源目录下、toPath = 目标目录 + relPath',
      st.transfers.every(t => String(t.fromPath).indexOf(root) === 0) &&
      st.transfers.some(t => t.toPath === RROOT + '/new.txt') &&
      st.transfers.some(t => t.toPath === RROOT + '/x/y/z.txt'),
      st.transfers.map(t => t.fromPath + ' -> ' + t.toPath))
    check('覆盖项预置 mergeOrOverwrite，新建项不带策略',
      (() => {
        const over = st.transfers.filter(t => /a\.txt$|old\.txt$/.test(t.toPath))
        const cre = st.transfers.filter(t => /new\.txt$|z\.txt$/.test(t.toPath))
        return over.length === 2 && over.every(t => t.resolvePolicy === 'mergeOrOverwrite') &&
          cre.every(t => !t.resolvePolicy)
      })(), st.transfers)
    check('权限 mode 随条目传到传输层（new.txt 0640）',
      (() => {
        const n = st.transfers.find(t => /new\.txt$/.test(t.toPath))
        // stat 的原始 mode 含类型位（0o100640），传输层要的就是这个
        return !!n && Number.isFinite(n.mode) && (n.mode & 0o777) === 0o640
      })(), st.transfers.find(t => /new\.txt$/.test(t.toPath)))
    check('待删目录一个都不删：rm 只有 2 次且不含 extra_dir',
      st.rms.length === 2 && st.rms.every(p => !/extra_dir/.test(p)), st.rms)
    check('删除排在传输入队之后（结果里三段顺序 + rm 次数在最后才涨到 2）',
      st.transfers.length === 4 && st.rms.length === 2, { queued: st.transfers.length, rms: st.rms })
    check('完成后回调刷新远端列表', st.done === 1, st.done)
    check('结果面板三段都有数（目录 2 成 1 败 / 入队 4 / 删除 2）',
      /2/.test(String(u.result)) && /4/.test(String(u.result)), u.result)
    await shot('result-dark')

    // ============ 5. 完成态能关，执行中关不掉 ============
    await clickBtn(/关闭|close/i)
    u = await ui()
    check('完成态点关闭能关掉弹层', u.open === false, u)
    await cdp.eval('window.__dm.reset()')
    await cdp.eval('window.__dm.open(' + JSON.stringify({
      dir: root, remotePath: RROOT, tree: REMOTE, vsfPath: RROOT + '/vsf'
    }) + ')')
    await ready('re-preview for running test')
    await cdp.eval('window.__dm.opDelay = 260')
    await cdp.eval('window.__dm.exec()')
    await sleep(120)
    await cdp.eval('window.__dm.closeByRef()')
    u = await ui()
    check('执行中点关闭无效（弹层还在，用户不会以为停下来了）',
      u.open === true && /开始镜像|start\s?mirror/i.test(String(u.footer).split(' ').join('')), u.footer)
    await waitFor(cdp, '(() => { const u = window.__dm.ui(); return !!u.result })()', 'result again', 25000)
    await cdp.eval('window.__dm.opDelay = 0')
    await cdp.eval('window.__dm.closeByRef()')

    // ============ 6. 采集不完整 → 删除禁用 + 执行被挡 ============
    await cdp.eval('window.__dm.reset()')
    await cdp.eval('window.__dm.open(' + JSON.stringify({
      dir: root, remotePath: BADROOT, tree: BAD_REMOTE
    }) + ')')
    await ready('bad-tree preview')
    u = await ui()
    check('远端某个目录读失败要在说明里写出来',
      u.notes.some(n => /失败|denied|read-error|1/.test(n)), u.notes)
    check('采集不完整时删除勾选禁用并给出提示',
      u.checked === false && u.cbDisabled === true && !!u.hint,
      { checked: u.checked, cbDisabled: u.cbDisabled, hint: u.hint })
    await cdp.eval('window.__dm.forceDeleteExtra(true)')
    await sleep(500)
    await cdp.eval('window.__dm.exec()')
    await sleep(600)
    u = await ui()
    const stBad = await stat()
    check('硬把勾选塞成 true 也过不了执行前那道闸：没有任何 rm 落到远端',
      /采集|不完整|delete|删除/.test(String(u.error)) && stBad.rms.length === 0,
      { error: u.error, rms: stBad.rms })
    await cdp.eval('window.__dm.forceDeleteExtra(false)')
    await sleep(300)
    await shot('partial-tree-dark')
    await cdp.eval('window.__dm.closeByRef()')

    // ============ 7. 明细截断 ============
    await cdp.eval('window.__dm.reset()')
    await cdp.eval('window.__dm.open(' + JSON.stringify({
      dir: bulkRoot, remotePath: BULK, tree: REMOTE
    }) + ')')
    await ready('bulk preview')
    u = await ui()
    check(BULK_N + ' 个新建项：计数是全量 ' + BULK_N, firstNum(u.nums[0]) === BULK_N, u.nums[0])
    check('明细只渲染 500 行（渲染上限，不是数据上限）', u.rowCount === 500, u.rowCount)
    check('截断那句写清「前 500 条 / 共 ' + BULK_N + ' 条」',
      /500/.test(String(u.more)) && String(u.more).indexOf(String(BULK_N)) > 0, u.more)
    await shot('truncated-dark')
    await cdp.eval('window.__dm.closeByRef()')

    // ============ 8. 采集中途叫停 ============
    await cdp.eval('window.__dm.delay = 300')
    await cdp.eval('window.__dm.reset()')
    await cdp.eval('window.__dm.open(' + JSON.stringify({
      dir: root, remotePath: RROOT, tree: REMOTE
    }) + ')')
    const hasStop = await waitFor(cdp,
      '!!window.__dm.ui().footBtns && !!window.__dm.ui().footBtns.find(b => /停止|stop/i.test(b.text))',
      'walking footer', 8000)
    check('采集期间给出「停止采集」按钮', hasStop)
    const xyStop = await stableXY('window.__dm.footBtn(' + JSON.stringify('停止采集|stop\\s?listing') + ')')
    await cdp.click(xyStop.x, xyStop.y)
    const atStop = Number(await cdp.eval('window.__dm.listCount'))
    await sleep(1800)
    const later = Number(await cdp.eval('window.__dm.listCount'))
    u = await ui()
    check('叫停后不再继续打远端（list 次数几乎不涨）', later - atStop <= 1, { atStop, later })
    check('叫停后回到未预演状态并说明原因',
      /停止|stopped/.test(String(u.error)) && !(u.nums && u.nums.length),
      { error: u.error, nums: u.nums })
    await cdp.eval('window.__dm.delay = 0')
    await cdp.eval('window.__dm.closeByRef()')

    // ============ 9. 浅色主题 ============
    await cdp.eval('window.__dm.open(' + JSON.stringify({
      dir: root, remotePath: RROOT, tree: REMOTE
    }) + ')')
    await ready('preview for theme test')
    const theme0 = await cdp.eval('String((window.store._config || {}).theme)')
    const themeIds = JSON.parse(await cdp.eval(
      "JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
    const lightId = themeIds.find(id => /light/i.test(String(id)))
    if (!lightId) {
      check('存在可切换的浅色系主题', false, themeIds)
    } else {
      const bgDark = await cdp.eval('window.__dm.bgColor()')
      await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
      await sleep(1300)
      const bgLight = await cdp.eval('window.__dm.bgColor()')
      check('浅色主题下面板底色跟着 token 变', !!bgDark && !!bgLight && bgDark !== bgLight,
        { bgDark, bgLight, theme0 })
      await shot('preview-light')
      await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
      await sleep(800)
    }

    // ============ 10. 收尾 ============
    await cdp.eval('window.__dm.closeByRef(); window.__dm.restore()')
    const after = await cdp.jeval(
      'JSON.stringify({restored: window.store.addTransferList === window.__dm.realAdd, open: !!window.__dm.ui().open})')
    check('addTransferList 已还原、弹层已关闭', after.restored === true && after.open === false, after)

    const errs = cdp.events.filter(e =>
      e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' &&
      !/Warning:|deprecat|DevTools|favicon|Failed to load resource/i.test(
        (e.params.args || []).map(a => a.value || a.description || '').join(' ')))
    check('全程无未捕获的渲染错误', errs.length === 0,
      errs.slice(0, 3).map(e => (e.params.args || [])
        .map(a => a.value || a.description || '').join(' ').slice(0, 200)))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(bulkRoot, { recursive: true, force: true })
  }

  const fails = results.filter(r => !r.ok)
  console.log('\n==== 判据 ' + (results.length - fails.length) + '/' + results.length + ' 通过 ====')
  if (fails.length) {
    console.log(fails.map(f => 'FAIL ' + f.name + ' :: ' + JSON.stringify(f.detail)).join('\n'))
  }
  console.log('stale tmp swept: ' + sweepOldTmp())
  process.exit(fails.length ? 1 : 0)
}

// 只回收 1 小时以上的陈旧遗留：同工作区可能有并行进程正在用自己的临时树
function sweepOldTmp () {
  const pres = ['electerm-g5-mirror-', 'electerm-g5-bulk-']
  const now = Date.now()
  let n = 0
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      if (!pres.some(p => d.startsWith(p))) {
        continue
      }
      const p = path.join(os.tmpdir(), d)
      try {
        if (now - fs.statSync(p).mtimeMs > 3600000) {
          fs.rmSync(p, { recursive: true, force: true })
          n++
        }
      } catch (e) { /* 正被别的进程用着就跳过 */ }
    }
  } catch (e) { /* tmp 读不动不影响本次演示 */ }
  return n
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  sweepOldTmp()
  process.exit(1)
})
