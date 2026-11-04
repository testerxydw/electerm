// 顶栏 A→B→C 顺序的实机量测（不依赖 npm run build，不碰共享的 work/ 目录）：
// 把真实的 .styl 编译成 CSS，喂真实 DOM 结构与真实 antd 尺寸，在真浏览器里量
// 条高 / 分隔线 / 图标字号 / 条目顺序。用法：node self-test/topbar-order-probe.js
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const styl = (rel) => path.join(ROOT, 'src/client', rel)

const css = [
  execFileSync('./node_modules/.bin/stylus', [
    '--print',
    styl('css/includes/theme.styl'),
    styl('css/includes/tokens.styl'),
    styl('css/includes/text.styl'),
    styl('components/common/session-shell.styl'),
    styl('components/sftp/sftp.styl')
  ], { cwd: ROOT }).toString()
].join('\n')

// antd v6 在栏内实际渲染出来的骨架（尺寸取自 antd 6.5.1 的 small 控件默认值），
// 用来验证"新加的 column-gap / 分隔线 / 16px 图标"不会把 32px 行盒撑高。
// 基础 .anticon 用 :where() 写 —— 特异度 0，跟产品的后代选择器比谁赢是真浏览器里的比法
const stub = `
:where(.anticon) { display: inline-flex; font-size: 14px; }
.anticon > svg { width: 1em; height: 1em; fill: currentColor; }
.ant-select.ant-select-sm { display: inline-flex; align-items: center; height: 24px;
  padding: 0 7px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-2); font-size: 12px; }
// antd 的下拉箭头自己带 12px（特异度高于产品的排除规则），照搬进桩
.ant-select .ant-select-arrow { display: inline-flex; margin-left: 4px; }
.ant-select .ant-select-arrow .anticon { font-size: 12px; }
.ant-switch.ant-switch-small { display: inline-flex; align-items: center; width: 28px; height: 16px;
  border-radius: 999px; background: var(--primary); border: 0; }
.switch-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
// .anticon 基础 display 由上面的 :where() 给（产品运行时由 antd 注入）
`

const icon = (name) => `<span role="img" class="anticon anticon-${name} pointer"><svg viewBox="64 64 896 896"></svg></span>`

const dom = `
<div class="remote-session-wrap vnc-session-wrap">
  <div class="remote-session-control session-v-info">
    <div class="remote-session-control-left">
      <span class="remote-session-info"><span class="remote-session-info-name">fake-desktop</span>127.0.0.1:5901</span>
      ${icon('reload')}
      <span class="ant-select ant-select-sm"><span class="ant-select-content">Screen 1</span><span class="ant-select-arrow">${icon('down')}</span></span>
      <span class="switch-label"><button class="ant-switch ant-switch-small"></button>缩放</span>
    </div>
    <div class="remote-session-control-right">
      ${icon('fullscreen')}
      <div class="remote-float-control-inline"><div class="remote-float-btn-inline">${icon('more')}</div></div>
    </div>
  </div>
  <div class="remote-session-viewport"><div style="height: 400px"></div></div>
</div>
<div class="sftp-panel-title sftp-panel-title-remote">
  <span class="sftp-panel-title-text elli">user@172.16.0.5</span>
  <span role="img" class="anticon anticon-reload pointer mg1r sftp-panel-refresh"><svg viewBox="64 64 896 896"></svg></span>
</div>
`

const probe = `
(() => {
  const r = []
  const bar = document.querySelector('.remote-session-control')
  const left = document.querySelector('.remote-session-control-left')
  const info = left.querySelector('.remote-session-info')
  const kids = [...left.children].map(el => el.className)
  const line = getComputedStyle(info, '::after')
  const reload = left.querySelector('.anticon-reload')
  const select = left.querySelector('.ant-select')
  const arrow = left.querySelector('.ant-select-arrow .anticon')
  const sw = left.querySelector('.ant-switch')
  const box = (el) => el.getBoundingClientRect()
  const mid = box(bar).top + box(bar).height / 2
  const off = (el) => Math.round((box(el).top + box(el).height / 2 - mid) * 10) / 10
  const title = document.querySelector('.sftp-panel-title-remote')
  r.push({
    barH: Math.round(box(bar).height * 10) / 10,
    leftH: Math.round(box(left).height * 10) / 10,
    leftOrder: kids,
    gap: getComputedStyle(left).columnGap,
    sep: { content: line.content, w: line.width, h: line.height, display: line.display },
    reloadCenterOff: off(reload),
    selectCenterOff: off(select),
    switchCenterOff: off(sw),
    iconFont: getComputedStyle(reload).fontSize,
    arrowFont: getComputedStyle(arrow).fontSize,
    infoRight: Math.round(box(info).right),
    reloadLeft: Math.round(box(reload).left),
    selectLeft: Math.round(box(select).left),
    titleH: Math.round(box(title).height * 10) / 10,
    titleOrder: [...title.children].map(el => el.className.split(' ')[0]),
    titleTextLeft: Math.round(box(title.children[0]).left),
    titleIconRight: Math.round(box(title.children[1]).right),
    titleWrapRight: Math.round(box(title).right),
    titleRefreshMarginLeft: getComputedStyle(title.children[1]).marginLeft,
    titleRefreshDisplay: getComputedStyle(title.children[1]).display
  })
  return JSON.stringify(r)
})()
`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-topbar-probe-'))
const file = path.join(dir, 'probe.html')
fs.writeFileSync(file, `<html><head><meta charset="utf-8"><style>${css}${stub}</style></head><body style="background: var(--main); color: var(--text); margin: 0">${dom}<script>document.title = ${probe}</script></body></html>`)

const out = execFileSync('microsoft-edge', [
  '--headless', '--disable-gpu', '--no-sandbox', '--window-size=1600,1000',
  '--virtual-time-budget=1500', '--dump-dom', `file://${file}`
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const m = out.match(/<title>([\s\S]*?)<\/title>/)
if (!m) {
  console.error('no title came back; headless dump failed')
  process.exit(1)
}
const [res] = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
console.log(JSON.stringify(res, null, 2))
fs.rmSync(dir, { recursive: true, force: true })

const checks = [
  ['remote 条高仍是 32px 一行', Math.abs(res.barH - 32) <= 0.5 && Math.abs(res.leftH - 32) <= 0.5],
  ['左栏顺序 = 信息 → 重连 → 控件', res.leftOrder[0].includes('remote-session-info') && res.leftOrder[1].includes('anticon-reload')],
  ['信息排在控件之前', res.infoRight <= res.reloadLeft && res.reloadLeft < res.selectLeft],
  ['A/B 之间有 1px 竖线', res.sep.w === '1px' && res.sep.h === '16px' && res.sep.content !== 'none'],
  ['栏内图标 16px、Select 箭头不受影响', res.iconFont === '16px' && res.arrowFont === '12px'],
  ['条目同一条中线（±1px）', [res.reloadCenterOff, res.selectCenterOff, res.switchCenterOff].every(v => Math.abs(v) <= 1)],
  ['sftp 标题行 32px 一行', Math.abs(res.titleH - 32) <= 0.5],
  ['sftp 刷新图标是弹性盒里的贴右项', res.titleRefreshDisplay !== 'none' && res.titleRefreshMarginLeft.endsWith('px') && parseFloat(res.titleRefreshMarginLeft) > 100],
  ['sftp 标题：信息在左、刷新贴右', res.titleOrder[0] === 'sftp-panel-title-text' && Math.abs(res.titleIconRight - res.titleWrapRight) <= 12]
]
let fail = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) fail++
}
process.exit(fail ? 1 : 0)
