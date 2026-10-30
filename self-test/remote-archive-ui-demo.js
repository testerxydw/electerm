#!/usr/bin/env node
/**
 * G4 远程归档 —— 弹层 UI 的 CDP 实机演示/回归（假 sftp 驱动）
 *
 * 单测钉的是命令拼接（remote-archive.spec）、主进程执行（session-sftp-archive.spec）、
 * 渲染层纯函数与接线契约（remote-archive-ui.spec）。这里验的是只有真渲染才看得见的东西：
 *   1) 默认名「看到什么就得到什么」——提示行与真正发出去的 dest 同源
 *   2) 空名在点下按钮前就挡住，一次命令都不发
 *   3) 换格式换的是后缀（app.js.tar.gz → app.js.zip），不是叠一层
 *   4) 远端没 zip 降级成 tar.gz 时，提示说的是换名后的那个文件
 *   5) 失败时 stderr 尾巴在弹层里看得见，弹层不自己关掉
 *   6) 执行中没有可点的取消/关闭（客户端本来就停不了远端命令）
 *   7) 解压前必须先看到清单：清单没回来时解压按钮不可点，超上限要如实说
 *   8) 完成后回调刷新列表（否则用户看不见刚生成的文件）
 *   9) 浅色主题下面板配色跟着 token 走
 *
 * 假 sftp 只替掉三个归档方法（archiveCreate/List/Extract），弹层、默认名、清单门槛、
 * 结果转达全是真代码路径；远端命令本身由 remote-archive-cmd-check.js 走真 tar/zip 验证，
 * 两边不重叠。
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/common/ work/app/common/
 *   2) 起带 --remote-debugging-port=9227 的实例
 *   3) node self-test/remote-archive-ui-demo.js [debugPort] [shotDir]
 */
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9227'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'remote-archive-ui-shots')

const PROBE = `
(() => {
  // 判定不写死语言：本机词条可能是中文也可能是英文
  const norm = x => String(x == null ? '' : x).split(' ').join('')
  const ra = {
    calls: [],
    done: 0,
    seq: 0,
    sftp: {
      archiveCreate: (a) => ra.defer('create', a),
      archiveList: (a) => ra.defer('list', a),
      archiveExtract: (a) => ra.defer('extract', a)
    },
    // 每次调用挂成一个可外部了结的 Promise，才能演「执行中」和「失败」两种状态
    defer (f, a) {
      const d = { i: ++ra.seq, f, a, state: 'pending' }
      d.p = new Promise((resolve, reject) => {
        d.resolve = v => { d.state = 'done'; resolve(v) }
        d.reject = e => { d.state = 'failed'; reject(e) }
      })
      ra.calls.push(d)
      return d.p
    },
    settle (i, data, errMsg, stderrTail) {
      const d = ra.calls.find(x => x.i === i)
      if (!d) return 'no-call:' + i
      if (errMsg) {
        const e = new Error(errMsg)
        if (stderrTail) e.stderrTail = stderrTail
        d.reject(e)
      } else {
        d.resolve(data)
      }
      return d.state
    },
    open (mode, files, file) {
      const m = window.refsStatic.get('remote-archive-modal')
      if (!m) return 'no-modal'
      const onDone = () => { ra.done++ }
      if (mode === 'create') {
        m.showCreate({ files, sftp: ra.sftp, onDone })
      } else {
        m.showExtract({ file, sftp: ra.sftp, onDone })
      }
      return 'opened'
    },
    // 走组件自己的关闭入口（含「执行中不许关」那道判断）
    closeByRef () {
      const m = window.refsStatic.get('remote-archive-modal')
      if (!m) return 'no-modal'
      m.handleClose()
      return 'closed'
    },
    root () {
      return [...document.querySelectorAll('.remote-archive-modal')].find(el =>
        getComputedStyle(el).display !== 'none')
    },
    ui () {
      const el = ra.root()
      if (!el) return { open: false, done: ra.done }
      const t = s => { const n = el.querySelector(s); return n ? (n.innerText || '').trim() : null }
      const input = el.querySelector('.remote-archive-name-input')
      const list = el.querySelector('.remote-archive-list')
      return {
        open: true,
        done: ra.done,
        title: t('.custom-modal-title'),
        footBtns: [...el.querySelectorAll('.custom-modal-footer button')]
          .map(b => ({ text: norm(b.innerText), disabled: !!b.disabled })),
        name: input ? input.value : null,
        kind: t('.remote-archive-kind'),
        dests: [...el.querySelectorAll('.remote-archive-dest')].map(n => (n.innerText || '').trim()),
        labels: [...el.querySelectorAll('.remote-archive-label')].map(n => (n.innerText || '').trim()),
        listLines: list ? (list.innerText || '').split('\\n').filter(Boolean).length : null,
        listHead: list ? (list.innerText || '').split('\\n').filter(Boolean).slice(0, 3) : null,
        banner: t('.remote-archive-banner'),
        notice: t('.remote-archive-notice'),
        result: t('.remote-archive-result'),
        error: t('.remote-archive-error'),
        detail: t('.remote-archive-detail'),
        nameError: t('.remote-archive-name-error'),
        running: t('.remote-archive-running')
      }
    },
    setName (v) {
      const el = ra.root()
      const input = el && el.querySelector('.remote-archive-name-input')
      if (!input) return 'no-input'
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'set'
    },
    xy (el) {
      if (!el) return JSON.stringify({ error: 'no-el' })
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return JSON.stringify({ error: 'zero-size' })
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    },
    // 页脚按钮：按归一化文字找，顺带回传禁用态（门槛判据要看这个）
    footBtn (re) {
      const el = ra.root()
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
    kindXY () {
      const el = ra.root()
      // antd 6 的 Select 内部没有 .ant-select-selector 了，可点的是 .ant-select-content
      const s = el && (el.querySelector('.remote-archive-kind .ant-select-content') ||
        el.querySelector('.remote-archive-kind'))
      return ra.xy(s)
    },
    optXY (label) {
      const dd = [...document.querySelectorAll('.ant-select-dropdown')]
        .find(x => !x.className.includes('ant-select-dropdown-hidden') && x.offsetParent !== null)
      const o = dd && [...dd.querySelectorAll('.ant-select-item-option')]
        .find(x => norm(x.innerText) === label)
      return ra.xy(o)
    },
    closeXY () {
      const el = ra.root()
      return ra.xy(el && el.querySelector('.custom-modal-close'))
    },
    // 面板底色：换主题后要变，证明颜色来自 token 不是写死
    bgColor () {
      const el = ra.root()
      const c = el && el.querySelector('.custom-modal-content')
      return c ? getComputedStyle(c).backgroundColor : null
    }
  }
  window.__ra = ra
  return 'ok'
})()
`

const FILES_ONE = [{ id: 'f1', name: 'app.js', path: '/srv/data', type: 'remote', isDirectory: false }]
const FILES_TAR = [{ id: 'f2', name: 'b.tar', path: '/srv/data', type: 'remote', isDirectory: false }]
const FILE_ZIP = { id: 'f9', name: 'app.zip', path: '/srv/data', type: 'remote', isDirectory: false }
const FILE_BIG = { id: 'f10', name: 'big.tar.gz', path: '/srv/data', type: 'remote', isDirectory: false }

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
    width: 1600, height: 950, deviceScaleFactor: 1, mobile: false
  })
  await cdp.call('Page.reload', { ignoreCache: true })
  // 只等 store/pre 会踩空：重载前旧文档里这两个早就在，判据当场通过，
  // 紧接着新文档把 window.refsStatic 装上之前取组件实例就会拿到 undefined
  await waitFor(cdp, '!!window.store && !!window.pre && !!window.refsStatic && ' +
    "!!window.refsStatic.get('remote-archive-modal')", 'renderer boots with archive modal', 120000)
  await sleep(1500)
  cdp.events.length = 0

  const { check, results } = makeChecker()
  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(350)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }
  const ui = () => cdp.jeval('JSON.stringify(window.__ra.ui())')
  const calls = () => cdp.jeval('JSON.stringify(window.__ra.calls)')
  const clickBtn = async re => {
    const xy = await cdp.jeval('window.__ra.footBtn(' + re.toString() + ')')
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
      await sleep(200)
    }
    return JSON.parse(prev || '{"error":"unstable"}')
  }
  const openCreate = async (expectName) => {
    await cdp.eval('window.__ra.open("create", ' + JSON.stringify(FILES_ONE) + ', null)')
    await waitFor(cdp, 'window.__ra.ui().open' +
      (expectName ? ' && window.__ra.ui().name === ' + JSON.stringify(expectName) : ''), 'create modal opens')
  }
  const openExtract = async () => {
    await cdp.eval('window.__ra.open("extract", null, ' + JSON.stringify(FILE_ZIP) + ')')
    await waitFor(cdp, 'window.__ra.ui().open', 'extract modal opens')
  }

  const PACK = /打包|Create/
  const EXTRACT = /解压|Extract/
  const CANCEL = /取消|cancel/i

  await cdp.eval(PROBE)
  check('弹层挂在主界面且能取到实例',
    await cdp.eval("!!window.refsStatic.get('remote-archive-modal')"))

  // ── 1. 单选：默认名 = 原名 + 后缀，提示与提交同源 ──────────────
  await openCreate()
  let s = await ui()
  check('打包弹层打开（标题不是驼峰 key 原文）',
    s.open && !!s.title && !/^RemoteArchive/.test(s.title), s.title)
  check('单选默认名 = 原名 + .tar.gz', s.name === 'app.js.tar.gz', s.name)
  check('「生成到」提示给出完整落点',
    (s.dests[0] || '').includes('/srv/data/app.js.tar.gz'), s.dests)
  check('页脚给取消 + 打包两个按钮',
    s.footBtns.length === 2 && PACK.test(s.footBtns[1].text) && CANCEL.test(s.footBtns[0].text),
    s.footBtns)
  await shot('pack-dark')

  // ── 2. 空名：点下按钮也不发命令 ────────────────────────────────
  await cdp.eval('window.__ra.setName("")')
  await sleep(300)
  await clickBtn(PACK)
  s = await ui()
  check('空名被挡住并给出说明', !!s.nameError && !s.result && !s.error, s.nameError)
  check('校验不过时一条命令都不发', (await calls()).length === 0, await calls())

  // ── 3. 含空格/中文的名字：提示与 dest 同源 ─────────────────────
  const NAME = '日志 目录 含空格'
  await cdp.eval('window.__ra.setName(' + JSON.stringify(NAME) + ')')
  await sleep(300)
  await clickBtn(PACK)
  let cs = await calls()
  check('打包发出 create 调用一次', cs.length === 1 && cs[0].f === 'create', cs)
  const wantDest = '/srv/data/' + NAME + '.tar.gz'
  check('dest 就是提示里那个路径（含空格/中文不拆）',
    cs[0].a.dest === wantDest && (await ui()).dests[0].includes(wantDest), cs[0].a)
  check('sources 传的是绝对路径数组',
    Array.isArray(cs[0].a.sources) && cs[0].a.sources[0] === '/srv/data/app.js', cs[0].a.sources)
  const doneBefore1 = s.done
  await cdp.eval('window.__ra.settle(' + cs[0].i + ', ' + JSON.stringify({
    producedPath: wantDest,
    kind: 'tar.gz',
    fallback: false,
    noticeKey: null,
    stderrTail: ''
  }) + ')')
  await sleep(420)
  s = await ui()
  check('成功后原地给结果，不自动关窗',
    s.open && !!s.result && s.result.includes(NAME + '.tar.gz'), s.result)
  check('成功回调触发列表刷新一次', s.done === doneBefore1 + 1, { doneBefore1, done: s.done })

  // ── 4. 换格式换的是后缀 ────────────────────────────────────────
  await cdp.eval('window.__ra.closeByRef()')
  await sleep(320)
  await openCreate('app.js.tar.gz')
  const kindXY = await stableXY('window.__ra.kindXY()')
  if (kindXY.error) {
    check('能点到格式选择器', false, kindXY)
  } else {
    await cdp.click(kindXY.x, kindXY.y)
    const zipXY = await stableXY('window.__ra.optXY("zip")')
    check('下拉里有 zip 选项', !zipXY.error, zipXY)
    if (!zipXY.error) {
      await cdp.click(zipXY.x, zipXY.y)
      await sleep(420)
      s = await ui()
      check('换成 zip 时换的是后缀（不叠 .zip.zip）',
        s.name === 'app.js.zip' && s.kind.replace(/\s/g, '') === 'zip',
        { name: s.name, kind: s.kind })
      check('提示行跟着换成 .zip', s.dests[0].includes('/srv/data/app.js.zip'), s.dests)
    }
  }
  await shot('kind-zip')

  // ── 5. 远端没有 zip：如实转达换了后缀的产出 ────────────────────
  cs = await calls()
  const before = cs.length
  await clickBtn(PACK)
  cs = await calls()
  const zipCall = cs[cs.length - 1]
  check('切完格式后发出的是 zip 请求',
    cs.length === before + 1 && zipCall.f === 'create' && zipCall.a.kind === 'zip',
    zipCall && zipCall.a)
  const fallbackPath = '/srv/data/app.js.tar.gz'
  await cdp.eval('window.__ra.settle(' + zipCall.i + ', ' + JSON.stringify({
    producedPath: fallbackPath,
    kind: 'tar.gz',
    fallback: true,
    noticeKey: 'remoteArchiveNoZip',
    stderrTail: ''
  }) + ')')
  await sleep(420)
  s = await ui()
  check('降级提示说明改成了 tar.gz',
    !!s.notice && /zip/i.test(s.notice) && /tar\.gz/.test(s.notice), s.notice)
  check('降级时结果里的路径是换名后的那个',
    !!s.result && s.result.includes(fallbackPath) && !s.result.includes('NO_ZIP'), s.result)
  await shot('zip-fallback')

  // ── 6. 失败：stderr 尾巴看得见，弹层不关 ───────────────────────
  await cdp.eval('window.__ra.closeByRef()')
  await sleep(320)
  await openCreate()
  await clickBtn(PACK)
  cs = await calls()
  const errCall = cs[cs.length - 1]
  const doneBefore2 = (await ui()).done
  await cdp.eval('window.__ra.settle(' + errCall.i + ', null, "archive create failed (exit 127)", "tar: /srv/data/nope: Cannot stat: No such file or directory")')
  await sleep(420)
  s = await ui()
  check('失败原因显示在弹层里（不自动关窗）',
    s.open && !!s.error && /exit 127/.test(s.error), s.error)
  check('stderr 最后几行一起给出', !!s.detail && /Cannot stat/.test(s.detail), s.detail)
  check('失败不触发列表刷新', s.done === doneBefore2, { doneBefore2, done: s.done })
  await shot('create-error')

  // ── 7. 执行中：没有能点的取消/关闭 ─────────────────────────────
  await cdp.eval('window.__ra.closeByRef()')
  await sleep(320)
  await cdp.eval('window.__ra.open("create", ' + JSON.stringify(FILES_TAR) + ', null)')
  await waitFor(cdp, 'window.__ra.ui().open && !!window.__ra.ui().name', 'reopen for running')
  await clickBtn(PACK)
  s = await ui()
  const packBtn = s.footBtns.find(b => PACK.test(b.text))
  check('执行中按钮进入 loading 且不可点', !!packBtn && packBtn.disabled === true, s.footBtns)
  check('执行中说明「远端执行、无法中断」',
    !!s.running && /中断|interrupt/i.test(s.running), s.running)
  check('执行中页脚没有第二个能点的按钮（不给假取消）',
    s.footBtns.filter(b => !b.disabled).length === 0, s.footBtns)
  const xyClose = await stableXY('window.__ra.closeXY()')
  if (!xyClose.error) {
    await cdp.click(xyClose.x, xyClose.y)
    await sleep(420)
    check('执行中点右上角关闭不生效（结果不会丢在半路）',
      (await ui()).open === true)
  } else {
    check('执行中点右上角关闭不生效（结果不会丢在半路）', false, xyClose)
  }
  await shot('running')
  // 收尾这笔挂着的调用：了结后再关，不留悬空 Promise
  cs = await calls()
  await cdp.eval('window.__ra.settle(' + cs[cs.length - 1].i + ', ' + JSON.stringify({
    producedPath: '/srv/data/b.tar.tar.gz', kind: 'tar.gz', fallback: false, noticeKey: null, stderrTail: ''
  }) + ')')
  await sleep(300)
  await cdp.eval('window.__ra.closeByRef()')
  await sleep(320)

  // ── 8. 解压：清单回来前不可点 ──────────────────────────────────
  await openExtract()
  const listCall = (await calls()).filter(c => c.f === 'list').slice(-1)[0]
  check('打开解压就先去列清单', !!listCall, await calls())
  check('清单请求带的是归档绝对路径',
    listCall.a.archivePath === '/srv/data/app.zip', listCall.a)
  s = await ui()
  const exBtn = s.footBtns.find(b => EXTRACT.test(b.text))
  check('清单没回来时解压按钮不可点', !!exBtn && exBtn.disabled === true, s.footBtns)
  check('清单在加载时不给空的确认依据', s.listLines === null && !s.result, s.listLines)
  const entries = ['bin/app', 'share/app/config.json', '日志 说明.txt']
  await cdp.eval('window.__ra.settle(' + listCall.i + ', ' + JSON.stringify({
    kind: 'zip', entries, total: entries.length, truncated: false, stderrTail: ''
  }) + ')')
  await sleep(420)
  s = await ui()
  check('清单回来后逐条可见',
    s.listLines === 3 && (s.listHead || []).join('|').includes('日志 说明.txt'), s.listHead)
  check('解压目标就是当前目录', s.dests.some(d => d.includes('/srv/data')), s.dests)
  const exBtn2 = (await ui()).footBtns.find(b => EXTRACT.test(b.text))
  check('清单回来后解压按钮可点', !!exBtn2 && exBtn2.disabled === false, exBtn2)
  await shot('extract-listing')

  // ── 9. 解压执行与结果 ──────────────────────────────────────────
  const doneBefore3 = (await ui()).done
  await clickBtn(EXTRACT)
  const ex = (await calls()).find(c => c.f === 'extract')
  check('解压发出 archivePath + destDir',
    !!ex && ex.a.archivePath === '/srv/data/app.zip' && ex.a.destDir === '/srv/data', ex && ex.a)
  await cdp.eval('window.__ra.settle(' + ex.i + ', ' + JSON.stringify({
    ok: true, kind: 'zip', producedPath: '/srv/data/app.zip', destDir: '/srv/data', stderrTail: ''
  }) + ')')
  await sleep(420)
  s = await ui()
  check('解压结果原地报告并刷新列表',
    !!s.result && s.result.includes('/srv/data') && s.done === doneBefore3 + 1,
    { result: s.result, doneBefore3, done: s.done })

  // ── 10. 清单超上限要如实说 ─────────────────────────────────────
  await cdp.eval('window.__ra.closeByRef()')
  await sleep(320)
  await cdp.eval('window.__ra.open("extract", null, ' + JSON.stringify(FILE_BIG) + ')')
  await waitFor(cdp, 'window.__ra.ui().open', 'extract big opens')
  const bigList = (await calls()).filter(c => c.f === 'list').slice(-1)[0]
  const many = Array.from({ length: 2000 }, (v, i) => 'dir/file-' + i + '.txt')
  await cdp.eval('window.__ra.settle(' + bigList.i + ', ' + JSON.stringify({
    kind: 'tar-gz', entries: many, total: 2001, truncated: true, stderrTail: ''
  }) + ')')
  await sleep(900)
  s = await ui()
  check('超上限明确说只给了前 2000 条', !!s.banner && /2000/.test(s.banner), s.banner)
  check('条目数按总量报（不谎报成 2000）',
    s.labels.some(t => /2001/.test(t)), s.labels)
  check('截断时只渲染前 2000 条', s.listLines === 2000, s.listLines)
  await shot('listing-truncated')

  // ── 11. 词条落地（不是 key 原文）───────────────────────────────
  const texts = [s.title, s.banner, s.dests[0], s.labels.join('|')].join('|')
  check('界面文字都有词条（无 RemoteArchiveXxx 原文）',
    !/RemoteArchive[A-Z]/.test(texts), texts.slice(0, 120))

  // ── 12. 浅色主题跟随 token ─────────────────────────────────────
  const darkBg = await cdp.eval('window.__ra.bgColor()')
  // 取当前主题 id 用 store._config.theme 原值：包一层 String() 会在缺失时留下
  // "undefined" 字符串，恢复那一步就变成 setTheme('undefined')
  const cfg0 = await cdp.eval('window.store._config && window.store._config.theme')
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1500)
    const lightBg = await cdp.eval('window.__ra.bgColor()')
    check('换浅色主题后面板底色跟着变（不是写死）',
      !!darkBg && !!lightBg && lightBg !== darkBg, { darkBg, lightBg })
    await shot('extract-light')
    if (typeof cfg0 === 'string' && cfg0) {
      await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0) + ')')
      await sleep(800)
    }
  } else {
    check('存在可切换的浅色系主题', false, themeIds)
  }

  await cdp.eval('window.__ra.closeByRef()')
  const events = cdp.events.slice()
  if (events.length) {
    console.log('renderer log:\n  ' + events.join('\n  '))
  }
  check('渲染层无异常记录', events.filter(l => l.startsWith('EX')).length === 0, events.slice(0, 4))

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
