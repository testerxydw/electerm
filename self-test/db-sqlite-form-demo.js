#!/usr/bin/env node
/**
 * H8a-b SQLite 连接表单 + 引擎身份呈现 —— CDP 实机验收
 *
 * 为什么必须实机（源码守卫替代不了）：
 * - 字段显隐走 antd Form 的 shouldUpdate 包装，"隐藏"必须真的不占位，
 *   而且隐藏后 required 不再挡保存（只有真表单会算这套规则）；
 * - 引擎下拉、库文件输入框的 addonAfter 选择按钮、说明 Alert 都是 antd 组件盒模型；
 * - 连接目标文本（页签 tooltip / 会话头部 / 失败卡片）是三条不同渲染路径，
 *   单测只钉得住纯函数，钉不住"这一页真的取的是库文件，而不是残留的 127.0.0.1:3306"。
 *
 * 覆盖（32 条）：
 *   1) 引擎下拉含 SQLite；默认 MySQL 显示网络字段、不显示库文件
 *   2) 切到 SQLite：主机/端口/用户名/密码/库名/SSL/隧道全部消失，
 *      出现库文件输入框 + 选择按钮 + 说明 Alert
 *   3) 切到 SQLite 再切回 MySQL：手工填过的端口不被抹掉（"不清字段"的口径）
 *   4) 手输带成对引号与首尾空格的路径 → 失焦后归一
 *   5) 只填库文件即可保存（隐藏字段的 required 不再挡路）
 *   6) 双击书签开出会话页签，真的连上 SQLite，结构树里有 product / v_price
 *   7) 会话头部目标 = 库文件名，且不含残留 host:port；引擎标与页签前缀都是 SQLite
 *   8) 页签 tooltip：位置行标题是"库文件"、值是完整路径，没有主机行
 *   9) 指向不存在文件的书签：失败卡片目标是文件名，原因是 SQLite 专门文案
 *  10) 深浅两套主题下同一份呈现（切主题不丢连接）
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起一个带 --remote-debugging-port 的实例（隔离 HOME）：
 *      DISPLAY=:130 HOME=/tmp/electerm-h8a/home \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-sqlite-form-demo.js [debugPort] [shotDir]
 *
 * 注意：脚本开头会重载渲染层，那只对 renderer 代码有效。
 * 词条（src/app/common/locales-extra.js）和主进程侧改动走的是 app.js，
 * 改完必须重启实例，否则表单标签会退化成"DbFile"这种人形化的 key，
 * 而 required 校验用的还是空字段——表现是"保存没报错但书签没进树"。
 *
 * 夹具：/tmp/electerm-h8a/demo/shop.db（表 product 4 行 + 视图 v_price），每次跑前重建。
 * 书签写在该实例自己的 userData（隔离 HOME）里，不进仓库、不含真实凭据。
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sqlite-form-shots')
const DEMO_DIR = '/tmp/electerm-h8a/demo'
const DB_FILE = path.join(DEMO_DIR, 'shop.db')
const BAD_FILE = path.join(DEMO_DIR, 'nope-not-here.db')
const OK_NAME_BASE = 'h8a-shop'
const BAD_NAME_BASE = 'h8a-bad'
// 每次跑用新名字：判据是"书签出现在树里"，复用固定名会被上一轮的遗留书签蒙混过关
const RUN_TAG = process.env.H8A_RUN_TAG || String(Date.now()).slice(-6)
const OK_NAME = OK_NAME_BASE + '-' + RUN_TAG
const BAD_NAME = BAD_NAME_BASE + '-' + RUN_TAG

const { check, results } = makeChecker()
const J = s => JSON.stringify(s)

// 页内探针。返回对象/数组即可（CDP returnByValue 会序列化回宿主）。
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
  // 侧栏收起时书签面板只是被宽度裁掉，display 一路都是 block——
  // 只看样式会把"看不见也点不到"的节点判成可见，故补一条命中测试。
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
  window.__items = () => [...document.querySelectorAll('.ant-form-item')].filter(window.__vis)
  // 表单项按 label 文本找：label 一改判据就红，比写死 id 更容易看懂
  window.__itemByLabel = txt => {
    const flat = s => String(s).replace(/\\s/g, '')
    return window.__items().find(i => {
      const lab = i.querySelector('.ant-form-item-label label')
      return lab && flat(lab.innerText).indexOf(flat(txt)) >= 0
    }) || null
  }
  window.__inputOf = txt => {
    const it = window.__itemByLabel(txt)
    return it ? it.querySelector('input, textarea') : null
  }
  window.__valOf = txt => {
    const el = window.__inputOf(txt)
    return el ? String(el.value) : null
  }
  // React 受控输入：改 el.value 不算数，必须走原生 setter + input 事件
  window.__setInput = (txt, v) => {
    const el = window.__inputOf(txt)
    if (!el) return 'no-input:' + txt
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__blur = txt => {
    const el = window.__inputOf(txt)
    if (!el) return 'no-input'
    // React 的 onBlur 挂在原生 focusout 上：直接 dispatchEvent(new Event('blur')) 打不中，
    // 必须真的获得焦点再失焦，才会走用户"点别处"的那条路
    el.focus()
    el.blur()
    return 'ok'
  }
  window.__labels = () => window.__items()
    .map(i => { const l = i.querySelector('.ant-form-item-label label'); return l ? l.innerText.trim() : '' })
    .filter(Boolean)
  window.__alerts = () => [...document.querySelectorAll('.ant-alert')]
    .filter(window.__vis).map(a => a.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean)
  window.__opts = () => [...document.querySelectorAll('.ant-select-item-option')]
    .filter(window.__vis).map(o => o.innerText.trim())
  window.__optXY = name => {
    const el = [...document.querySelectorAll('.ant-select-item-option')]
      .filter(window.__vis).find(o => o.innerText.trim() === name)
    return el ? window.__xy(el) : null
  }
  window.__treeText = () => {
    const el = [...document.querySelectorAll('.db-tree')].filter(window.__vis)[0]
    return el ? el.innerText.replace(/\\s+/g, ' ').slice(0, 400) : null
  }
  // 主区页签是自绘的 .tab（不是 .ant-tabs-tab），tooltip 挂在 .tab-title 上
  window.__mainTabXY = name => {
    const el = [...document.querySelectorAll('.tab')].filter(window.__vis)
      .find(t => t.innerText.indexOf(name) >= 0)
    const target = el && (el.querySelector('.tab-title') || el)
    return target ? window.__xy(target) : null
  }
  // SQLite 的树是「schema(main) → 表/视图」，schema 默认收起：不展开就读不到表
  window.__collapsedSwitcherXY = () => {
    const el = [...document.querySelectorAll('.db-tree .ant-tree-switcher_close')]
      .filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  window.__headTarget = () => {
    const el = [...document.querySelectorAll('.db-head-target')].filter(window.__vis)[0]
    return el ? { text: el.innerText.trim(), title: el.getAttribute('title') || '' } : null
  }
  window.__tipRows = () => {
    const wrap = [...document.querySelectorAll('.db-tip-list')].filter(window.__vis)[0]
    if (!wrap) return null
    return [...wrap.querySelectorAll('.db-tip-row')].map(r => ({
      k: ((r.querySelector('.db-tip-key') || {}).innerText) || '',
      v: ((r.querySelector('.db-tip-val') || {}).innerText) || ''
    }))
  }
  window.__failCard = () => {
    const el = [...document.querySelectorAll('.db-conn-fail')].filter(window.__vis)[0]
    return el ? el.innerText.replace(/\\s+/g, ' ') : null
  }
  // 书签树用的是自绘的 .tree-item-title。别把 .ant-tree-title 一起收进来：
  // 数据库结构树也是 antd Tree，标题节点同样叫 .ant-tree-title，
  // 混在一起会让"书签树里有 x 吗"被结构树的 main 冒充成"有"
  window.__bkText = () => [...document.querySelectorAll('.tree-item-title')]
    .filter(window.__vis).map(n => n.innerText.trim()).filter(Boolean)
  window.__bkXY = name => {
    const el = [...document.querySelectorAll('.tree-item-title')]
      .filter(window.__vis).find(n => n.innerText.indexOf(name) >= 0)
    return el ? window.__xy(el) : null
  }
  window.__saveXY = () => {
    // antd 会在两个汉字的按钮里插一个空格（"保 存"），比对前先去掉空白；
    // 且要精确匹配，否则会把"保存并连接/保存并新建"当成保存按钮点下去
    const b = [...document.querySelectorAll('button')].filter(window.__vis)
      .find(x => /^(保存|完成|确定|save|ok|apply)$/i.test(x.innerText.replace(/\\s/g, '')))
    return b ? window.__xy(b) : null
  }
  // antd 6 的 Select 里没有 .ant-select-selector（改成 .ant-select-content > .ant-select-input），
  // 两个都试：写死一个的话升级后判据只会报"点不到"，看不出是没渲染还是类名变了
  window.__selectXY = it => {
    const el = it && (it.querySelector('.ant-select-content') || it.querySelector('.ant-select-selector') || it.querySelector('.ant-select'))
    return el ? window.__xy(el) : null
  }
  window.__engineXY = () => window.__selectXY(
    window.__itemByLabel('数据库类型') || window.__itemByLabel('引擎') || window.__itemByLabel('dbType'))
  // 书签表单顶部的类型切换条（Ssh/Sftp / Telnet / … / 数据库）是一组 radio
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
  window.__typeXY = () => window.__selectXY(window.__itemByLabel('类型'))
  return 1
})()`

async function main () {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  writeFixture()
  const page = findPageTarget(await getJson(`http://127.0.0.1:${PORT}/json/list`))
  if (!page) {
    throw new Error('端口 ' + PORT + ' 上没有页面目标')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  // 验收必须跑在刚构建出来的包上：实例往往是先起的，vite-build 之后渲染层还是旧代码，
  // 不重载就会测到"上一版界面"，判据红了也定位不到是产品问题还是没刷新
  await cdp.call('Page.reload', { ignoreCache: true })
  const ready = await waitFor(cdp, '!!document.querySelector(".bookmark-sidebar-toggle")', '应用未就绪', 40000)
  if (!ready) {
    throw new Error('重载后应用未就绪：' + JSON.stringify(cdp.tail(6)))
  }
  await sleep(1200)
  await cdp.eval(HELPERS)

  const click = async (p, ms = 500) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y)
    await sleep(ms)
  }
  const dblclick = async p => {
    if (!p) throw new Error('双击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y, 2)
    await sleep(600)
  }
  // "新建书签"是书签面板顶部工具条的一个裸 anticon（不是 button），
  // 面板右半边留给搜索框，所以按 x<290 限定在面板内，避免命中别处的 + 号
  const newBtnXY = () => cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.anticon-plus-circle')]
      .filter(window.__vis).find(b => b.getBoundingClientRect().left < 290)
    return el ? window.__xy(el) : null
  })()`)
  const openForm = async () => {
    // 书签面板可能已经开着（重启会恢复上次布局）：先找"新建书签"图标，找不到才点侧栏图标。
    // 无条件点图标会把已开的面板关掉，后面的判据就全成"点不到目标"。
    let btn = await newBtnXY()
    if (!btn) {
      await click(await cdp.eval('window.__at(".bookmark-sidebar-toggle")'), 900)
      btn = await newBtnXY()
    }
    if (!btn) {
      throw new Error('找不到"新建书签"图标（.anticon-plus-circle）')
    }
    await click(btn, 400)
    // 表单是异步挂载的：不等它出现就点类型，等于点在空气上
    if (!await waitFor(cdp, '!!window.__dbTypeChipXY()', '书签表单未打开', 10000)) {
      throw new Error('点了"新建书签"也没打开表单：' + JSON.stringify(cdp.tail(5)))
    }
    // 已选中就不点：切换类型会重建成另一种 initValues，等于把刚填的东西清空
    if (!(await cdp.eval('window.__dbTypeChipChecked()'))) {
      await click(await cdp.eval('window.__dbTypeChipXY()'), 600)
    }
    const ok = await waitFor(cdp, '!!window.__engineXY()', '数据库类型字段未出现', 8000)
    if (!ok) {
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
  // 点完"保 存"表单并不关闭，所以"保存成功"只能看书签有没有真的进树。
  // 关浮层的动作留给调用方：书签视图（左树 + 右表单）是一层覆盖主区的浮层，
  // 提前关掉就再也点不到书签节点；不关掉则会话头部一直压在浮层下面取不到。
  const closeForm = async () => {
    // 浮层有两个关闭图标（左上/右上），取最后一个：实测右上那个位置会压到别的控件上
    const p = await cdp.eval(`(() => {
      const a = [...document.querySelectorAll('.close-setting-wrap')].filter(window.__vis).map(window.__xy)
      return a.length ? a[a.length - 1] : null
    })()`)
    if (!p) return false
    await click(p, 700)
    return waitFor(cdp, '![...document.querySelectorAll(".close-setting-wrap")].some(window.__vis)',
      '书签浮层没关掉', 6000)
  }
  // 关浮层会连左侧书签面板一起收掉；双击开连接要在"只有侧栏树"的状态下做
  // （实测：表单浮层还开着时双击树节点不会开出会话页签）
  const ensureSidebar = async () => {
    if ((await cdp.eval('window.__bkText()')).length) return true
    await click(await cdp.eval('window.__at(".bookmark-sidebar-toggle")'), 1000)
    return waitFor(cdp, 'window.__bkText().length > 0', '书签树没出现', 8000)
  }
  // 双击书签开一个会话：坐标必须在双击前重新取（保存后树会重排），
  // 且第一下没开成就再点一次——只凭"没报错"往下走，后面全是空判据
  const openBookmark = async name => {
    for (let n = 0; n < 2; n++) {
      const p = await cdp.eval(`window.__bkXY(${J(name)})`)
      if (!p) return 'no-node'
      await dblclick(p)
      const opened = await waitFor(cdp,
        `(window.store.tabs || []).some(t => t.type === 'database' && (t.title || '').indexOf(${J(name)}) >= 0)`,
        '双击后没有开出会话页签', 6000)
      if (opened) return true
    }
    return false
  }
  const saveForm = async name => {
    const btn = await cdp.eval('window.__saveXY()')
    if (!btn) return 'no-save-button'
    await click(btn, 900)
    const ok = await waitFor(cdp, `window.__bkText().some(t => t.indexOf(${J(name)}) >= 0)`,
      '保存后书签未出现在树里：' + name, 8000)
    return ok
  }
  const setTitle = t => cdp.eval(`(() => {
    const it = window.__itemByLabel('标题') || window.__itemByLabel('名称')
    const el = it && it.querySelector('input')
    if (!el) return 'no-title-input'
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${J(t)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)

  // ---- 清场 ----
  // 判据取"第一个可见的 .db-head-target / .db-tree"，留着上一轮的会话页签
  // 就会把旧会话的头当成新会话的头，红绿都不作数
  const cleared = await clearDbTabs(cdp)
  if (cleared.left.length) {
    console.log('WARN 仍有没关掉的数据库页签', JSON.stringify(cleared.left))
  }

  // ---- 打开数据库书签表单 ----
  await openForm()
  check('数据库书签表单出现引擎字段', !!(await cdp.eval('window.__engineXY()')))
  await cdp.shot(path.join(SHOT_DIR, '1-form-mysql.png'))

  // ---- 1) 引擎下拉与默认（MySQL）字段可见性 ----
  await click(await cdp.eval('window.__engineXY()'), 700)
  const options = await cdp.eval('window.__opts()')
  check('引擎下拉含 SQLite（与 dbTypeLabelMap 同名）',
    Array.isArray(options) && options.includes('SQLite'), options)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' })
  await sleep(400)
  const labelsMysql = await cdp.eval('window.__labels()')
  const all = (list, ...ts) => ts.every(t => list.some(l => l.indexOf(t) >= 0))
  check('MySQL 下显示主机/端口/用户名/密码/库',
    all(labelsMysql, '主机', '端口', '用户名', '密码', '库'), labelsMysql)
  check('MySQL 下不显示库文件', !labelsMysql.some(l => l.indexOf('库文件') >= 0), labelsMysql)

  // ---- 2) 切到 SQLite ----
  check('能选中 SQLite 引擎', await pickEngine('SQLite'))
  const labelsSqlite = await cdp.eval('window.__labels()')
  check('SQLite 下隐藏主机/端口/用户名/密码/库名/SSL/隧道',
    !labelsSqlite.some(l => /主机|端口|用户名|密码|数据库名|SSL|TLS|隧道/.test(l)), labelsSqlite)
  check('SQLite 下出现库文件字段', labelsSqlite.some(l => l.indexOf('库文件') >= 0), labelsSqlite)
  const ctl = await cdp.eval(`(() => {
    const it = window.__itemByLabel('库文件')
    if (!it) return null
    const inp = it.querySelector('input')
    return {
      hasInput: !!inp,
      hasPickBtn: !!it.querySelector('.ant-input-group-addon button, .ant-input-group-addon .anticon'),
      placeholder: inp ? inp.placeholder : '',
      required: !!it.querySelector('.ant-form-item-required')
    }
  })()`)
  check('库文件字段 = 输入框 + 原生选择按钮，且标为必填',
    !!ctl && ctl.hasInput && ctl.hasPickBtn && ctl.required, ctl)
  check('库文件占位符提到 :memory:', /memory/.test((ctl && ctl.placeholder) || ''), ctl && ctl.placeholder)
  const alerts = await cdp.eval('window.__alerts()')
  check('SQLite 下给出"路径不存在不会替你建库"的说明',
    (alerts || []).some(a => /不存在|不会替你|fails to connect/i.test(a)), alerts)
  await cdp.shot(path.join(SHOT_DIR, '2-form-sqlite.png'))

  // ---- 3) 手填端口在引擎来回切换后仍在（不清字段的口径） ----
  await pickEngine('MySQL')
  await cdp.eval('window.__setInput("端口", "12345")')
  await pickEngine('SQLite')
  const back = await pickEngine('MySQL')
  const portVal = await cdp.eval('window.__valOf("端口")')
  check('切到 SQLite 不清掉手填端口（切回 MySQL 仍是 12345）', back && portVal === '12345', portVal)
  check('再切回 SQLite，库文件字段还在', await pickEngine('SQLite'))

  // ---- 4) 路径归一（成对引号 + 首尾空格） ----
  await cdp.eval(`window.__setInput('库文件', ${J(' "' + DB_FILE + '" ')})`)
  await cdp.eval('window.__blur("库文件")')
  const norm = await cdp.eval('window.__valOf("库文件")')
  check('失焦后路径归一（去引号与首尾空格）', norm === DB_FILE, norm)
  check('书签标题可填写', await setTitle(OK_NAME) === 'ok')
  await cdp.shot(path.join(SHOT_DIR, '3-form-filled.png'))

  // ---- 5) 保存 ----
  const saved = await saveForm(OK_NAME)
  check('只填库文件即可保存（隐藏字段的 required 不再挡路）', saved === true, saved)
  await sleep(800)
  const bkText = await cdp.eval('window.__bkText()')
  check('书签出现在书签树里', (bkText || []).some(t => t.indexOf(OK_NAME) >= 0), bkText)

  // ---- 6) 打开书签：真连上 SQLite ----
  await closeForm()
  check('书签浮层能关掉', await ensureSidebar())
  const opened = await openBookmark(OK_NAME)
  check('双击书签会开出数据库页签', opened === true, opened)
  const connected = await waitFor(cdp, `(() => {
    const t = window.__headTarget()
    return !!(t && t.text.indexOf('shop.db') >= 0)
  })()`, 'SQLite 会话未连上', 25000)
  const head = await cdp.eval('window.__headTarget()')
  check('双击书签后 SQLite 会话连上（头部显示库文件名）', connected, head)
  // schema 节点收起时树里只有 main，直接读文本会把"没展开"误判成"没读到表"
  for (let i = 0; i < 3; i++) {
    const sw = await cdp.eval('window.__collapsedSwitcherXY()')
    if (!sw) break
    await click(sw, 1200)
  }
  await waitFor(cdp, `(() => {
    const t = window.__treeText()
    return !!t && /product/.test(t) && /v_price/.test(t)
  })()`, '结构树里等不到 product / v_price', 12000)
  const treeTxt = await cdp.eval('window.__treeText()')
  check('结构树里有表 product 与视图 v_price',
    !!treeTxt && /product/.test(treeTxt) && /v_price/.test(treeTxt), treeTxt)
  await cdp.shot(path.join(SHOT_DIR, '4-session-opened.png'))

  // ---- 7) 头部目标不含残留 host:port；引擎徽标 ----
  check('会话头部不出现被忽略的 127.0.0.1:3306',
    !/127\.0\.0\.1|:3306/.test(((head && head.text) || '') + ' ' + ((head && head.title) || '')), head)
  const badge = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.db-head-engine')].filter(window.__vis)[0]
    return el ? el.innerText.trim() : null
  })()`)
  check('会话头部的引擎标是 SQLite', badge === 'SQLite', badge)
  const tabTitle = await cdp.eval(`(() => {
    const t = [...document.querySelectorAll('.tab')].filter(window.__vis)
      .find(x => x.innerText.indexOf(${J(OK_NAME)}) >= 0)
    const el = t && t.querySelector('.tab-title')
    return el ? el.innerText.trim() : null
  })()`)
  check('页签标题带 [SQLite] 前缀', /\[SQLite\]/.test(String(tabTitle)), tabTitle)

  // ---- 8) 页签 tooltip ----
  const tabXY = await cdp.eval(`window.__mainTabXY(${J(OK_NAME)})`)
  if (tabXY) {
    await cdp.move(tabXY.x, tabXY.y)
    await sleep(400)
    // 挪一下再等：antd Tooltip 要 mouseenter 之后的停留时间，一次 move 有时只算 mouseover
    await cdp.move(tabXY.x + 2, tabXY.y + 1)
    await sleep(1800)
  } else {
    console.log('WARN 找不到页签，tooltip 判据将拿不到内容')
  }
  const tip = await cdp.eval('window.__tipRows()')
  check('页签 tooltip 有"库文件"行且值是完整路径',
    !!tip && tip.some(r => /库文件|Database file/i.test(r.k) && r.v === DB_FILE), tip)
  check('页签 tooltip 不再出现主机地址行', !!tip && !tip.some(r => /主机|host/i.test(r.k)), tip)
  await cdp.shot(path.join(SHOT_DIR, '5-tab-tooltip.png'))

  // ---- 9) 坏路径书签：失败卡片口径 ----
  await openForm()
  check('第二条表单也切到 SQLite', await pickEngine('SQLite'))
  await cdp.eval(`window.__setInput('库文件', ${J(BAD_FILE)})`)
  await setTitle(BAD_NAME)
  const saved2 = await saveForm(BAD_NAME)
  check('第二条（坏路径）书签保存成功', saved2 === true, saved2)
  await sleep(800)
  await closeForm()
  await ensureSidebar()
  const opened2 = await openBookmark(BAD_NAME)
  check('坏路径书签也开出页签（连接失败前页签已在）', opened2 === true, opened2)
  const hasFail = await waitFor(cdp, '!!window.__failCard()', '坏路径未出现失败卡片', 25000)
  const card = hasFail ? await cdp.eval('window.__failCard()') : null
  check('坏路径出现连接失败卡片', hasFail, String(card).slice(0, 140))
  check('失败卡片目标显示文件名（不是空 host:port）',
    /nope-not-here\.db/.test(String(card)), String(card).slice(0, 200))
  check('失败原因走 SQLite 专门文案（不是通用"检查主机端口"）',
    /库文件|SQLite 文件|database file/i.test(String(card)), String(card).slice(0, 240))
  await cdp.shot(path.join(SHOT_DIR, '6-conn-fail.png'))

  // ---- 10) 另一套主题下同一份呈现 ----
  // 最后打开的是坏路径那条会话，先把好会话切回前台，
  // 否则"头部还显示 shop.db"测的是另一个页签
  const okTabId = await cdp.eval(`(() => {
    const t = (window.store.tabs || []).filter(x => x.type === 'database')
      .find(x => (x.title || '').indexOf(${J(OK_NAME)}) >= 0)
    return t ? t.id : null
  })()`)
  if (okTabId) {
    await cdp.eval(`window.store.changeActiveTabId(${J(okTabId)})`)
    await sleep(900)
  }
  const themeIds = await cdp.eval('JSON.stringify((window.store.getItems("terminalThemes") || []).map(t => t.id))')
  // 当前主题从 _config 读：store.getConfig('theme') 这个签名不存在，
  // 读不到就还原不了，等于把这套隔离环境留在浅色下给下一份脚本踩
  const curTheme = await cdp.eval('window.store._config && window.store._config.theme')
  const lightId = JSON.parse(themeIds).find(id => /light/i.test(String(id)))
  if (lightId) {
    await cdp.eval(`window.store.setTheme(${J(lightId)})`)
    await sleep(1400)
    const again = await waitFor(cdp, `(() => {
      const t = window.__headTarget()
      return !!(t && t.text.indexOf('shop.db') >= 0)
    })()`, '浅色主题下会话未连上', 20000)
    check('浅色主题下会话仍在（切主题不丢连接、目标仍是库文件）', again)
    await cdp.shot(path.join(SHOT_DIR, '7-theme-light.png'))
    await cdp.eval(`window.store.setTheme(${J(curTheme)})`)
    await sleep(800)
  } else {
    console.log('SKIP 浅色主题截图：没有 id 含 light 的主题', themeIds)
  }

  // 本脚本开的会话页签会被持久化恢复：留着，下一份脚本 Page.reload 后的
  // 异步恢复会把 activeTabId 改成它们自己，判据就跑在别人的页签上
  const leftover = await clearDbTabs(cdp)
  if (leftover.left.length) {
    console.log('WARN 收尾仍有未关闭的数据库页签', JSON.stringify(leftover.left))
  }

  console.log('\nEVENTS', JSON.stringify(cdp.tail(8)))
  const bad = results.filter(r => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 条通过`)
  cdp.ws.close()
  process.exit(bad.length ? 1 : 0)
}

// 夹具：真实 SQLite 文件（表 + 视图），值里带引号/反斜杠/通配符，
// H8a-c 的过滤与导出判据复用同一份
function writeFixture () {
  const { DatabaseSync } = require('node:sqlite')
  if (fs.existsSync(DB_FILE)) {
    fs.rmSync(DB_FILE)
  }
  const db = new DatabaseSync(DB_FILE)
  db.exec('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT, price REAL, note TEXT)')
  const ins = db.prepare('INSERT INTO product(name, price, note) VALUES(?, ?, ?)')
  ins.run('键盘', 299.5, null)
  ins.run("鼠标'带引号", 88, 'esc \\ % _ test')
  ins.run('显示器', 1899, '1920×1080')
  ins.run('USB-C 扩展坞', 349.9, 'a,b"c')
  db.exec('CREATE VIEW v_price AS SELECT name, price FROM product WHERE price > 100')
  db.close()
}

main().catch(e => {
  console.error('ERR', e && e.stack ? e.stack : e)
  process.exit(1)
})
