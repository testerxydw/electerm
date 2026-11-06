#!/usr/bin/env node
/**
 * N1 · TLS 证书校验档位 —— 书签表单 CDP 实机验收
 *
 * 为什么必须实机（源码守卫与握手脚本都替代不了）：
 * - 三个新字段挂在同一套"按 dbType 重渲染"的显隐机制上（common/fields.jsx 的
 *   shouldUpdate 只比较 dbType），"切到 SQLite 就消失"只有真表单会算；
 * - 档位默认值要看书签是不是新建（createBaseInitValues 的 isNew 分支），
 *   这条线错一个方向就是"升级后自签内网盘全连不上"或"新建书签默认不设防"；
 * - ca 档空路径的必填校验走 antd 的动态 rules（提交时才取值），
 *   单测里 assert 不到"点了保存但书签没入库"；
 * - 旧书签（没有 dbSslVerify 字段）在 UI 上必须显示"只加密、不校验"，
 *   并且**用户不改就直接保存**也不能被偷偷升成 system。
 *
 * 覆盖（18 条）见下面 check 的名字，大致分四组：
 *   A 网络引擎下的字段呈现（开关 / 档位下拉 / CA 文件 / 说明 Alert）
 *   B 引擎切换的显隐与"不清字段"
 *   C 保存：ca 空路径挡住 → 填好后入库 → 重开读回
 *   D 旧书签兼容（默认档位 + 保存不升级）+ 落盘字段核对
 *
 * 用法：
 *   1) npm run compile && 手工同步 src/app → work/app（compile 只打渲染层）：
 *      cp src/app/lib/db-client/{db-tls,mysql,postgres,redis}.js work/app/lib/db-client/
 *      cp src/app/common/locales-extra.js work/app/common/
 *   2) 独占 display + 端口（先确认端口空，别的会话共用会读到别人的现场）：
 *      Xvfb :136 -screen 0 1600x1000x24 -nolisten tcp &
 *      DISPLAY=:136 HOME=/tmp/electerm-n1/home \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9372 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-tls-form-demo.js [debugPort] [shotDir]
 *
 * 注意：脚本会 Page.reload 刷新渲染层，但**词条与主进程代码走 app.js**，
 * 改完必须重启实例，否则新字段的 label 会退化成 'DbSslVerifyLabel' 这种 key。
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9372'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'n1-tls-form-shots')
const RUN_TAG = process.env.N1_RUN_TAG || String(Date.now()).slice(-6)
const CA_FILE = '/tmp/electerm-n1/ca-good.pem'
const OK_NAME = 'n1-ca-' + RUN_TAG
// 旧书签夹具：按"上一版会写成什么样"直接进库，不带 dbSslVerify / dbSslCa
const LEGACY_NAME = 'n1-legacy-' + RUN_TAG

const { check, results } = makeChecker()
const J = s => JSON.stringify(s)

const HELPERS = `(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    if (window.__hidden(el)) return false
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top) || top.contains(el))
  }
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__at = sel => {
    const el = [...document.querySelectorAll(sel)].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  // 表单项的"可见"只看样式：这些项要么被 showWhen 整项不渲染，要么 display:none。
  // 用命中测试版（__vis）会因为表单项掉出滚动容器而误判成"没有这个字段"，
  // 于是 label 判据与点击坐标各说各话（实测：选完 ca 档后保存按钮就在视口外）。
  window.__visStyle = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return false
      n = n.parentElement
    }
    return true
  }
  // 点得到之前先把它滚进视口（instant：页面有 smooth 滚动时立刻量会读到动画途中的位置）
  window.__show = el => {
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    return el
  }
  window.__items = () => [...document.querySelectorAll('.ant-form-item')].filter(window.__visStyle)
  window.__itemByLabel = txt => {
    const flat = s => String(s).replace(/\\s/g, '')
    return window.__items().find(i => {
      const lab = i.querySelector('.ant-form-item-label label')
      return lab && flat(lab.innerText).indexOf(flat(txt)) >= 0
    }) || null
  }
  window.__has = txt => !!window.__itemByLabel(txt)
  window.__labels = () => window.__items()
    .map(i => { const l = i.querySelector('.ant-form-item-label label'); return l ? l.innerText.trim() : '' })
    .filter(Boolean)
  window.__inputOf = txt => {
    const it = window.__itemByLabel(txt)
    return it ? it.querySelector('input:not([type=checkbox]):not([type=radio]), textarea') : null
  }
  window.__valOf = txt => {
    const el = window.__inputOf(txt)
    return el ? String(el.value) : null
  }
  window.__setInput = (txt, v) => {
    const el = window.__inputOf(txt)
    if (!el) return 'no-input:' + txt
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  // Select 当前显示的是哪一项（antd6 的值容器与 antd5 不同名，两种都试）
  window.__selText = txt => {
    const it = window.__itemByLabel(txt)
    if (!it) return null
    const sel = it.querySelector('.ant-select')
    if (!sel) return null
    const item = sel.querySelector('.ant-select-selection-item')
    return String((item ? item.title || item.innerText : sel.innerText) || '').trim()
  }
  window.__selectXY = it => {
    const el = it && (it.querySelector('.ant-select-content') || it.querySelector('.ant-select-selector') || it.querySelector('.ant-select'))
    return el ? window.__xy(window.__show(el)) : null
  }
  window.__opts = () => [...document.querySelectorAll('.ant-select-item-option')]
    .filter(window.__vis).map(o => o.innerText.trim())
  window.__optXY = name => {
    const el = [...document.querySelectorAll('.ant-select-item-option')]
      .filter(window.__vis).find(o => o.innerText.trim() === name)
    return el ? window.__xy(el) : null
  }
  // antd Switch 的状态用 aria-checked 读，比 class 稳
  window.__switch = txt => {
    const it = window.__itemByLabel(txt)
    const el = it && it.querySelector('button.ant-switch, .ant-switch')
    if (!el) return null
    return { checked: el.getAttribute('aria-checked') === 'true', xy: window.__xy(window.__show(el)) }
  }
  window.__errTexts = () => [...document.querySelectorAll('.ant-form-item-explain-error')]
    .filter(window.__vis).map(e => e.innerText.trim()).filter(Boolean)
  window.__alerts = () => [...document.querySelectorAll('.ant-alert')]
    .filter(window.__visStyle).map(a => a.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean)
  window.__bkText = () => [...document.querySelectorAll('.tree-item-title')]
    .filter(window.__vis).map(n => n.innerText.trim()).filter(Boolean)
  window.__bkXY = name => {
    const el = [...document.querySelectorAll('.tree-item-title')]
      .filter(window.__vis).find(n => n.innerText.indexOf(name) >= 0)
    return el ? window.__xy(window.__show(el)) : null
  }
  // 设置面板「书签」页里的树：单击一行 = 选中并打开它的编辑表单。
  // 侧栏那条路走不通——config.doubleClickToOpenBookmark 为真时单击只是标记行，
  // 为假时单击直接建连（实测多开两个数据库页签），两种都不是"打开编辑表单"。
  window.__settingBkXY = name => {
    const el = [...document.querySelectorAll('.setting-tabs-bookmarks .tree-item-title')]
      .filter(window.__vis).find(n => n.innerText.indexOf(name) >= 0)
    return el ? window.__xy(window.__show(el)) : null
  }
  // 保存按钮在表单最底下：填过 TLS 这几项后它经常掉出视口，
  // 只按"可见 + 命中测试"取坐标就会拿到 null（表现是"点击目标不存在"），
  // 所以先滚到视口中间再量。behavior 显式 instant：页面有 smooth 滚动时
  // 立刻量会读到滚动动画途中的位置。
  // scope：侧栏表单和设置面板表单会同时渲染，不限定容器就点错另一份的按钮。
  window.__saveXY = scope => {
    const all = [...document.querySelectorAll((scope || '') + ' button')]
      .filter(x => /^(保存|完成|确定|save|ok|apply)$/i.test(x.innerText.replace(/\\s/g, '')))
      .filter(window.__visStyle)
    if (!all.length) return null
    return window.__xy(window.__show(all[0]))
  }
  // 下拉浮层还挂着时会压住下面的输入框/保存按钮：点一下表单标题把它关掉。
  // 用按键（Escape/Tab）不稳：它们作用在"当前焦点元素"上，而选完一项后焦点
  // 在 Select 还是表单里取决于渲染时序，实测关掉的是下拉还是整个表单说不准。
  window.__dropdownOpen = () => [...document.querySelectorAll('.ant-select-dropdown')]
    .filter(d => !d.className.includes('ant-select-dropdown-hidden') && window.__visStyle(d)).length
  window.__blankXY = () => {
    const lab = [...document.querySelectorAll('.ant-form-item-label label')]
      .filter(window.__vis)[0]
    return lab ? window.__xy(lab) : null
  }
  window.__engineXY = () => window.__selectXY(
    window.__itemByLabel('数据库类型') || window.__itemByLabel('引擎') || window.__itemByLabel('dbType'))
  window.__dbTypeChipXY = () => {
    const el = [...document.querySelectorAll('.ant-radio-button-wrapper')]
      .filter(window.__vis).find(b => /^(数据库|database)$/i.test(b.innerText.trim()))
    return el ? window.__xy(el) : null
  }
  window.__dbTypeChipChecked = () => {
    const el = [...document.querySelectorAll('.ant-radio-button-wrapper')]
      .filter(window.__vis).find(b => /^(数据库|database)$/i.test(b.innerText.trim()))
    return !!el && /checked/.test(String(el.className))
  }
  return 1
})()`

async function main () {
  fs.mkdirSync(path.dirname(CA_FILE), { recursive: true })
  fs.writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\nN1-FORM-DEMO-PLACEHOLDER\n-----END CERTIFICATE-----\n')
  const page = findPageTarget(await getJson(`http://127.0.0.1:${PORT}/json/list`))
  if (!page) throw new Error('端口 ' + PORT + ' 上没有页面目标')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.reload', { ignoreCache: true })
  const ready = await waitFor(cdp, '!!document.querySelector(".bookmark-sidebar-toggle")', '应用未就绪', 40000)
  if (!ready) throw new Error('重载后应用未就绪：' + JSON.stringify(cdp.tail(6)))
  await sleep(1200)
  await cdp.eval(HELPERS)

  const click = async (p, ms = 500) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y)
    await sleep(ms)
  }
  const newBtnXY = () => cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.anticon-plus-circle')]
      .filter(window.__vis).find(b => b.getBoundingClientRect().left < 290)
    return el ? window.__xy(el) : null
  })()`)
  const openForm = async () => {
    let btn = await newBtnXY()
    if (!btn) {
      await click(await cdp.eval('window.__at(".bookmark-sidebar-toggle")'), 900)
      btn = await newBtnXY()
    }
    if (!btn) throw new Error('找不到"新建书签"图标')
    await click(btn, 400)
    if (!await waitFor(cdp, '!!window.__dbTypeChipXY()', '书签表单未打开', 10000)) {
      throw new Error('点了"新建书签"也没打开表单：' + JSON.stringify(cdp.tail(5)))
    }
    if (!(await cdp.eval('window.__dbTypeChipChecked()'))) {
      await click(await cdp.eval('window.__dbTypeChipXY()'), 600)
    }
    if (!await waitFor(cdp, '!!window.__engineXY()', '数据库类型字段未出现', 8000)) {
      throw new Error('切到数据库类型后仍没有"数据库类型"字段')
    }
  }
  const pickEngine = async name => {
    const sel = await cdp.eval('window.__engineXY()')
    if (!sel) return false
    await click(sel, 700)
    const opt = await cdp.eval(`window.__optXY(${J(name)})`)
    if (!opt) return false
    await click(opt, 800)
    return true
  }
  // 表单里选下拉项：等浮层出现再点，点完等选择器文本变化（否则判据会读到上一项）
  const pickIn = async (labelText, optionText) => {
    const xy = await cdp.eval(`window.__selectXY(window.__itemByLabel(${J(labelText)}))`)
    if (!xy) return 'no-select'
    await click(xy, 700)
    const opt = await cdp.eval(`window.__optXY(${J(optionText)})`)
    if (!opt) return 'no-option'
    await click(opt, 700)
    const ok = await waitFor(cdp,
      `window.__selText(${J(labelText)}) === ${J(optionText)}`,
      '选完档位后选择框没有回显：' + optionText, 6000)
    // 还挂着的下拉浮层会压住下面的输入框/保存按钮，点表单标题把它关掉
    if (await cdp.eval('window.__dropdownOpen()') > 0) {
      await click(await cdp.eval('window.__blankXY()'), 400)
    }
    return ok ? 'ok' : 'not-reflected'
  }
  const setTitle = t => cdp.eval(`(() => {
    const it = window.__itemByLabel('标题') || window.__itemByLabel('名称')
    const el = it && it.querySelector('input')
    if (!el) return 'no-title-input'
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${J(t)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  const saveXY = scope => cdp.eval(`window.__saveXY(${J(scope || '')})`)
  const closeForm = async () => {
    const p = await cdp.eval(`(() => {
      const a = [...document.querySelectorAll('.close-setting-wrap')].filter(window.__vis).map(window.__xy)
      return a.length ? a[a.length - 1] : null
    })()`)
    if (!p) return false
    await click(p, 700)
    return waitFor(cdp, '![...document.querySelectorAll(".close-setting-wrap")].some(window.__vis)',
      '书签浮层没关掉', 6000)
  }
  const ensureSidebar = async () => {
    if ((await cdp.eval('window.__bkText()')).length) return true
    await click(await cdp.eval('window.__at(".bookmark-sidebar-toggle")'), 1000)
    return waitFor(cdp, 'window.__bkText().length > 0', '书签树没出现', 8000)
  }
  const closeSettings = () => cdp.eval(`(() => {
    window.store.hideSettingModal()
    return true
  })()`)
  // 重开某条书签的编辑表单：走设置面板的「书签」页（见 __settingBkXY 的注释）。
  // 等表单真的换成这条书签——标题读回等于它自己，才算"打开了这条的表单"。
  const openBookmarkForm = async name => {
    await cdp.eval(`(() => {
      window.store.storeAssign({ settingTab: 'bookmarks' })
      window.store.openSettingModal()
      return 1
    })()`)
    if (!await waitFor(cdp, `!!window.__settingBkXY(${J(name)})`, '设置面板书签页里找不到这条：' + name, 8000)) {
      return 'no-node'
    }
    await click(await cdp.eval(`window.__settingBkXY(${J(name)})`), 1200)
    return waitFor(cdp,
      `!!window.__itemByLabel('数据库类型') && window.__valOf('标题') === ${J(name)}`,
      '单击书签行没有打开它的编辑表单', 8000)
  }

  // ---- 清场 ----
  await closeSettings()
  const cleared = await clearDbTabs(cdp)
  if (cleared.left.length) console.log('WARN 仍有没关掉的数据库页签', JSON.stringify(cleared.left))

  // ================= A 网络引擎下的字段呈现 =================
  await openForm()
  check('A0 新建书签默认引擎 MySQL 且能看到 TLS 开关',
    !!(await cdp.eval('window.__switch("TLS")')) && (await cdp.eval('window.__has("证书校验方式")')),
    await cdp.eval('window.__labels()'))
  const sw = await cdp.eval('window.__switch("TLS")')
  check('A1 TLS 开关默认关闭（不能默认开 TLS 打不开普通库）', sw && sw.checked === false, sw)
  const modeDefault = await cdp.eval('window.__selText("证书校验方式")')
  check('A2 新建书签的档位默认 = 用系统根证书校验',
    modeDefault === '用系统根证书校验', modeDefault)
  await click(sw.xy, 700)
  const swOn = await cdp.eval('window.__switch("TLS")')
  check('A3 TLS 开关点得动（aria-checked 翻成 true）', swOn && swOn.checked === true, swOn)
  const modeSelect = await cdp.eval('window.__selectXY(window.__itemByLabel("证书校验方式"))')
  check('A4 档位下拉能定位（点得开的前提）', !!modeSelect, modeSelect)
  await click(modeSelect, 700)
  const opts = await cdp.eval('window.__opts()')
  check('A5 三档文案与顺序（系统根 / 指定 CA / 只加密）',
    JSON.stringify(opts) === JSON.stringify(['用系统根证书校验', '用指定 CA 文件校验', '只加密、不校验（有中间人风险）']),
    opts)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' })
  await sleep(400)
  const caCtl = await cdp.eval(`(() => {
    const it = window.__itemByLabel('CA 证书文件')
    if (!it) return null
    const inp = it.querySelector('input')
    return {
      hasInput: !!inp,
      hasPickBtn: !!it.querySelector('.ant-input-group-addon button, .ant-input-group-addon .anticon'),
      placeholder: inp ? inp.placeholder : '',
      required: !!it.querySelector('.ant-form-item-required')
    }
  })()`)
  check('A6 CA 字段 = 输入框 + 选择按钮（复用 H8a 的文件选择器组件）',
    !!caCtl && caCtl.hasInput && caCtl.hasPickBtn, caCtl)
  check('A7 CA 占位符说明格式（PEM / .crt / .cer）',
    /PEM|crt|cer/i.test((caCtl && caCtl.placeholder) || ''), caCtl && caCtl.placeholder)
  const alertsA = await cdp.eval('window.__alerts()')
  check('A8 说明 Alert 讲清"只加密"挡不住中间人',
    (alertsA || []).some(a => /中间人/.test(a)), alertsA)
  await cdp.shot(path.join(SHOT_DIR, '1-fields-mysql.png'))

  // ================= B 引擎切换的显隐与不清字段 =================
  check('B1 切到 SQLite 成功', await pickEngine('SQLite'))
  const labelsSqlite = await cdp.eval('window.__labels()')
  check('B2 SQLite 下 TLS 开关/档位/CA 三项都不出现',
    !labelsSqlite.some(l => /TLS|SSL|证书校验|CA 证书/.test(l)), labelsSqlite)
  const alertsSqlite = await cdp.eval('window.__alerts()')
  check('B3 SQLite 下 TLS 说明 Alert 也一起消失（不留无关文案）',
    !(alertsSqlite || []).some(a => /中间人|TLS/.test(a)), alertsSqlite)
  check('B4 切回 MySQL', await pickEngine('MySQL'))
  check('B5 切回来三项字段又出现', await cdp.eval(
    'window.__has("证书校验方式") && window.__has("CA 证书文件") && !!window.__switch("TLS")'),
  await cdp.eval('window.__labels()'))
  check('B6 来回切引擎不抹掉已选档位（仍是系统根）',
    (await cdp.eval('window.__selText("证书校验方式")')) === '用系统根证书校验',
    await cdp.eval('window.__selText("证书校验方式")'))

  // ================= C 保存：必填拦住 → 填好入库 → 重开读回 =================
  check('C1 能选中"用指定 CA 文件校验"', (await pickIn('证书校验方式', '用指定 CA 文件校验')) === 'ok',
    await cdp.eval('window.__selText("证书校验方式")'))
  await setTitle(OK_NAME)
  await click(await saveXY(), 1200)
  const errs1 = await cdp.eval('window.__errTexts()')
  const bkAfterBad = await cdp.eval('window.__bkText()')
  check('C2 开着 TLS + ca 档但没填路径：保存被必填挡住',
    (errs1 || []).some(t => /CA 证书文件/.test(t)), errs1)
  check('C3 被挡下时书签没有偷偷入库',
    !(bkAfterBad || []).some(t => t.indexOf(OK_NAME) >= 0), bkAfterBad)
  await cdp.shot(path.join(SHOT_DIR, '2-ca-required.png'))
  check('C4 CA 路径可填写', (await cdp.eval(`window.__setInput('CA 证书文件', ${J(CA_FILE)})`)) === 'ok')
  await click(await saveXY(), 1200)
  const errs2 = await cdp.eval('window.__errTexts()')
  const bkAfterOk = await cdp.eval('window.__bkText()')
  check('C5 填好路径即可保存（不再报必填）',
    (errs2 || []).length === 0 && (bkAfterOk || []).some(t => t.indexOf(OK_NAME) >= 0),
    { errs2, bk: (bkAfterOk || []).slice(0, 6) })
  // 落库字段核对：书签的显示名存在 title（不是 name）——按 name 找会得到 null，
  // 看起来像"保存没写库"，实际是查错了键（实测踩过）
  const persisted = await cdp.eval(`(() => {
    const b = (window.store.bookmarks || []).find(x => x.title === ${J(OK_NAME)})
    return b ? { dbSsl: b.dbSsl, dbSslVerify: b.dbSslVerify, dbSslCa: b.dbSslCa } : null
  })()`)
  check('C6 落库字段带档位与 CA 路径（buildConn 摊开书签才到得了适配器）',
    !!persisted && persisted.dbSsl === true && persisted.dbSslVerify === 'ca' && persisted.dbSslCa === CA_FILE,
    persisted)
  // 关掉浮层 → 设置面板「书签」页单击这条 → 表单读回的还是它自己存的那一档
  await closeForm()
  check('C7 书签浮层能关掉', await ensureSidebar())
  check('C8 单击书签打开它的编辑表单', (await openBookmarkForm(OK_NAME)) === true,
    await cdp.eval('window.__valOf("标题")'))
  const reopenMode = await cdp.eval('window.__selText("证书校验方式")')
  check('C9 重开后档位读回"用指定 CA 文件校验"', reopenMode === '用指定 CA 文件校验', reopenMode)
  check('C10 重开后开关是开的、CA 路径原样在',
    (await cdp.eval('!!(window.__switch("TLS") && window.__switch("TLS").checked)')) &&
      (await cdp.eval('window.__valOf("CA 证书文件")')) === CA_FILE,
    { checked: await cdp.eval('window.__switch("TLS")'), val: await cdp.eval('window.__valOf("CA 证书文件")') })
  await cdp.shot(path.join(SHOT_DIR, '3-reopened-ca.png'))

  // ================= D 旧书签兼容 =================
  // 直接按"上一版会写成什么样"插一条：只有 dbSsl 布尔，没有档位字段。
  // addBookmark 只进 bookmarks 数组、不进分组，而树是按分组渲染的，
  // 所以还要跑一遍应用自己启动时用的 fixBookmarkGroups（load-data.js:336）：
  // 它把"没归属任何组的书签"收进 default 组，正是升级后老数据在盘上的样子。
  const legacyAdded = await cdp.eval(`(async () => {
    const b = {
      id: ${J('n1-legacy-id-' + RUN_TAG)},
      title: ${J(LEGACY_NAME)},
      type: 'database',
      category: 'bookmark',
      dbType: 'mysql',
      dbHost: '127.0.0.1',
      dbPort: '3306',
      dbUser: 'root',
      dbName: 'demo',
      dbSsl: true
    }
    const res = await window.store.addBookmark(b, { force: true })
    window.store.fixBookmarkGroups()
    return JSON.stringify(res)
  })()`)
  check('D1 旧版形状的书签能直接入库', !!JSON.parse(legacyAdded).ok, legacyAdded)
  check('D2 打开旧书签的编辑表单', (await openBookmarkForm(LEGACY_NAME)) === true,
    await cdp.eval('window.__valOf("标题")'))
  const legacyMode = await cdp.eval('window.__selText("证书校验方式")')
  check('D3 旧书签显示"只加密、不校验"（不能默认升到系统根，否则当天全连不上）',
    legacyMode === '只加密、不校验（有中间人风险）', legacyMode)
  const legacySsl = await cdp.eval('window.__switch("TLS")')
  check('D4 旧书签的 TLS 开关读回是开的（dbSsl 没被默认值盖掉）',
    !!legacySsl && legacySsl.checked === true, legacySsl)
  await click(await saveXY('.setting-tabs-bookmarks'), 1200)
  const legacySaved = await cdp.eval(`(() => {
    const b = (window.store.bookmarks || []).find(x => x.title === ${J(LEGACY_NAME)})
    return b ? { dbSsl: b.dbSsl, dbSslVerify: b.dbSslVerify } : null
  })()`)
  check('D5 旧书签直接保存后仍是 none（保存动作不偷偷加严）',
    !!legacySaved && legacySaved.dbSsl === true &&
      ['none', undefined].includes(legacySaved.dbSslVerify), legacySaved)
  await cdp.shot(path.join(SHOT_DIR, '4-legacy-none.png'))

  // ---- 收尾：本脚本建的书签留在隔离 HOME 里（不进仓库），页签清干净 ----
  await closeSettings()
  await closeForm()
  const leftover = await clearDbTabs(cdp)
  if (leftover.left.length) console.log('WARN 收尾仍有未关闭的数据库页签', JSON.stringify(leftover.left))

  console.log('\nEVENTS', JSON.stringify(cdp.tail(8)))
  const bad = results.filter(r => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 条通过`)
  if (bad.length) console.log('FAILED:', bad.map(b => b.name).join(' | '))
  cdp.ws.close()
  process.exit(bad.length ? 1 : 0)
}

main().catch(e => {
  console.error('ERR', e && e.stack ? e.stack : e)
  process.exit(1)
})
