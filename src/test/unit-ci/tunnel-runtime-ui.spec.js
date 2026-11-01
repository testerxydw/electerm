// G9 隧道运行时面板（界面层）接线契约
// 弹层在 CI 里没有 jsdom 可渲染，这里钉的是"致命的接线错误"：入口判据写反、
// 面板去讲别的会话的隧道、状态由界面自己推断、启停请求发给了错的 pid、
// 词条只写了一半、样式写死颜色。行归一的真实行为归 tunnel-runtime.spec.js，
// 主进程那半归 ssh-tunnel-close.spec.js / session-ssh-tunnel-op.spec.js。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const PANEL = 'src/client/components/terminal/tunnel-runtime.jsx'
const STYL = 'src/client/components/terminal/tunnel-runtime.styl'
const APIS = 'src/client/components/terminal/terminal-apis.js'
const FOOTER = 'src/client/components/footer/footer-entry.jsx'
const FOOTER_STYL = 'src/client/components/footer/footer.styl'
const RUNTIME = 'src/client/common/tunnel-runtime.js'
const LOCALES = 'src/app/common/locales-extra.js'

let runtime
const loadRuntime = async () => {
  if (!runtime) {
    runtime = await import(pathToFileURL(path.join(ROOT, RUNTIME)).href)
  }
  return runtime
}

describe('G9 面板 -> 主进程：一条请求只动一条隧道', () => {
  test('terminal-apis 暴露 tunnelOp，且发的就是主进程白名单里那个 action', () => {
    const src = codeOf(read(APIS))
    const body = src.slice(src.indexOf('export function tunnelOp'))
    assert.match(body, /^export function tunnelOp \(pid, op, tunnelId, options\) \{/, '参数顺序：pid, op, tunnelId')
    assert.match(body, /action: 'tunnel-op'/)
    // dispatch-center -> terminal-api 从消息顶层取这三个键，塞进 body 里就没人看得见
    for (const key of ['pid,', 'op,', 'tunnelId,']) {
      assert.ok(body.includes('\n    ' + key), '顶层要带 ' + key.replace(',', ''))
    }
  })

  test('面板用 tab.id 当 pid、row.id 当 tunnelId（pid 就是 tab id，不是进程号）', () => {
    const src = codeOf(read(PANEL))
    assert.match(src, /import \{ tunnelOp \} from '\.\/terminal-apis'/)
    assert.match(src, /tunnelOp\(tab\.id, op, row\.id\)/)
    assert.equal(/tunnelOp\(\s*(tab\.pid|process\.pid|store\.activeTabId)/.test(src), false)
  })

  test('启停都只走 tunnelOp：面板里没有第二条通道，也没有自动重试', () => {
    const src = codeOf(read(PANEL))
    const forbad = ['runCmd', 'execCmd', 'window.pre.runGlobalAsync', 'setInterval', 'setTimeout', 'retry']
    for (const b of forbad) {
      assert.equal(src.includes(b), false, '不该出现 ' + b)
    }
  })

  test('在途只置这一行，且失败也要落回来', () => {
    const src = codeOf(read(PANEL))
    assert.match(src, /setPending\(p => \(\{ \.\.\.p, \[row\.id\]: true \}\)\)/)
    assert.match(src, /\.catch\(err =>/)
    assert.match(src, /\.finally\(\(\) => clearPending\(row\.id\)\)/)
    // withPending 只改一行，整表替换会把主进程刚推回来的别的状态盖掉
    assert.match(src, /withPending\(acc, id, !!pending\[id\]\)/)
  })
})

describe('G9 面板数据来源：只翻译主进程说的话', () => {
  test('行 = sshTunnelResults ∪ 书签 sshTunnels，界面不再自己拼', () => {
    const src = codeOf(read(PANEL))
    assert.match(src, /tunnelRows\(tab && tab\.sshTunnelResults, tab && tab\.sshTunnels\)/)
    // 状态文案一律来自归一模块给的 status，界面不许按 sshTunnelResults 的长短自行判断
    for (const bad of ['running: true', 'status: ', '.filter(r => r.error)']) {
      assert.equal(src.includes(bad), false, '不该自己造状态：' + bad)
    }
  })

  test('面板绑在打开它的那条会话上，不跟着切页漂移', () => {
    const src = codeOf(read(PANEL))
    assert.match(src, /store\.tabs\.find\(t => t\.id === tabId\)/)
    assert.equal(src.includes('store.currentTab'), false, '切页后 currentTab 会变成别的会话')
  })

  test('没连着就不能点，且原因写在界面上', () => {
    const src = codeOf(read(PANEL))
    assert.match(src, /tab\.status === statusMap\.success/)
    assert.match(src, /const action = connected \? tunnelAction\(row\) : null/)
    assert.match(src, /e\('tunnelSessionDown'\)/)
  })

  test('invalid 行没按钮，但必须给一句为什么', () => {
    const src = codeOf(read(PANEL))
    assert.match(src, /row\.status === TUNNEL_STATUS\.invalid \? e\('tunnelNoListenPort'\)/)
    assert.match(src, /tunnel-op-none/)
  })

  test('四种状态与五种类型都有文案，且 key 与归一模块同源', async () => {
    const { TUNNEL_STATUS, TUNNEL_TYPES } = await loadRuntime()
    const src = read(PANEL)
    const extra = require(path.join(ROOT, LOCALES))
    for (const s of Object.values(TUNNEL_STATUS)) {
      const key = src.match(new RegExp('\\[TUNNEL_STATUS\\.' + s + '\\]: \'(\\w+)\''))
      assert.ok(key, 'statusText 少了 ' + s)
      assert.ok(extra.en[key[1]], key[1] + ' 不在 en')
      assert.ok(extra.zh_cn[key[1]], key[1] + ' 不在 zh_cn')
    }
    for (const t of Object.values(TUNNEL_TYPES)) {
      for (const lang of ['en', 'zh_cn']) {
        assert.ok(Object.prototype.hasOwnProperty.call(extra[lang], t.key), t.key + ' 不在 ' + lang)
      }
    }
    // 归一模块给未知类型的那个 key 也不能漏
    assert.ok(extra.en.tunnelTypeUnknown && extra.zh_cn.tunnelTypeUnknown)
  })
})

describe('G9 入口：底栏那个图标什么时候该出现', () => {
  test('只有"能挂隧道的会话且真配了隧道"才给入口', () => {
    const src = codeOf(read(FOOTER))
    const body = src.slice(src.indexOf('function renderTunnelIcon'), src.indexOf('function renderEncodingInfo'))
    assert.match(body, /isShellSessionTab\(tab\)/)
    assert.match(body, /tab\.sshTunnels \|\| \[\]/)
    assert.match(body, /tab\.sshTunnelResults \|\| \[\]/)
    assert.match(body, /if \(!tunneled\) \{\n\s*return null/)
    // 本地终端页也满足 hasShellSession，用它当判据会开出一张点不动的面板
    assert.equal(body.includes('hasShellSession'), false)
  })

  test('入口挂在活动终端上，面板挂在入口之下', () => {
    const src = read(FOOTER)
    assert.match(src, /\{inActiveTerminal && renderTunnelIcon\(\)\}/)
    const mount = src.slice(src.indexOf('<TunnelRuntime'), src.indexOf('{inActiveTerminal && renderTunnelIcon()}'))
    assert.match(mount, /open=\{!!tunnelTabId\}/)
    assert.match(mount, /tabId=\{tunnelTabId\}/)
    assert.match(mount, /onClose=\{\(\) => setTunnelTabId\(''\)\}/)
  })

  test('面板打开时图标点亮，与传输/监控同一契约', () => {
    const src = read(FOOTER)
    assert.match(src, /const open = tunnelTabId === tab\.id/)
    assert.match(src, /terminal-tunnel-icon' \+ \(open \? ' active' : ''\)/)
    const styl = read(FOOTER_STYL)
    const block = styl.slice(styl.indexOf('.terminal-transfer-icon'), styl.indexOf('.terminal-footer-center'))
    assert.match(block, /\.terminal-tunnel-icon/)
    assert.match(block, /color var\(--success\)/)
  })

  test('点图标 = 开 / 关这一条会话的面板，不会同时开两条', () => {
    const src = read(FOOTER)
    assert.match(src, /onClick=\{\(\) => setTunnelTabId\(open \? '' : tab\.id\)\}/)
  })
})

describe('G9 词条与样式', () => {
  test('界面用到的每个 e(\'tunnel…\') 都有中英两份', () => {
    const extra = require(path.join(ROOT, LOCALES))
    const used = new Set()
    for (const file of [PANEL, RUNTIME]) {
      const src = read(file)
      for (const m of src.matchAll(/e\(\s*'tunnel([^']+)'/g)) {
        used.add('tunnel' + m[1])
      }
      for (const m of src.matchAll(/'(tunnel[A-Z][A-Za-z0-9]*)'/g)) {
        used.add(m[1])
      }
    }
    assert.ok(used.size >= 20, '扫到的 key 太少：' + used.size)
    const miss = [...used].filter(k =>
      !Object.prototype.hasOwnProperty.call(extra.en, k) ||
      !Object.prototype.hasOwnProperty.call(extra.zh_cn, k)
    )
    assert.deepEqual(miss, [], '缺词条：' + miss.join(', '))
  })

  test('每个 tunnel* key 在 en / zh_cn 各出现一次（不多不少）', () => {
    const src = read(LOCALES)
    const en = src.slice(src.indexOf('const en = {'), src.indexOf('const zhCn = {'))
    const zh = src.slice(src.indexOf('const zhCn = {'))
    const count = (block) => {
      const out = new Map()
      for (const m of block.matchAll(/^\s{2}(tunnel[A-Za-z0-9]+):/gm)) {
        out.set(m[1], (out.get(m[1]) || 0) + 1)
      }
      return out
    }
    const e1 = count(en)
    const z1 = count(zh)
    assert.ok(e1.size >= 20, 'en 里扫到的 tunnel* 太少：' + e1.size)
    for (const [k, n] of e1) {
      assert.equal(n, 1, k + ' 在 en 里写了 ' + n + ' 次')
    }
    for (const [k, n] of z1) {
      assert.equal(n, 1, k + ' 在 zh_cn 里写了 ' + n + ' 次')
    }
    for (const [k] of e1) {
      assert.ok(z1.has(k), k + ' 只写了英文')
    }
    for (const [k] of z1) {
      assert.ok(e1.has(k), k + ' 只写了中文')
    }
  })

  test('样式只用 token，不写死颜色', () => {
    const src = read(STYL)
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(src), false, '出现硬编码色值')
    assert.equal(/\brgba?\(/.test(src), false, '出现硬编码色值')
    assert.equal(/opacity\s*:/.test(src), false, '弱化只能改颜色，不能用 opacity 压暗（U2c 契约）')
    for (const t of [
      '--text', '--text-muted', '--primary-text', '--primary', '--success', '--error', '--warn',
      '--success-bg', '--error-bg', '--warn-bg', '--border', '--hover-bg',
      '--radius-sm', '--radius-pill', '--font-mono', '--fs-xs', '--sp-2'
    ]) {
      assert.ok(src.includes('var(' + t + ')'), '应用到 var(' + t + ')')
    }
  })

  test('表头与行共用同一个 grid 模板，列宽只有一处定义', () => {
    const src = read(STYL)
    const tpl = src.match(/\.tunnel-head,\n\.tunnel-line\n\s+display grid\n\s+grid-template-columns ([^0-9]*\d+px \d+px 1fr \d+px \d+px)/)
    assert.ok(tpl, '表头与行要共用 grid-template-columns')
    assert.equal(src.match(/grid-template-columns/g).length, 2, '窄窗口那一处之外不再定义列宽')
  })
})
