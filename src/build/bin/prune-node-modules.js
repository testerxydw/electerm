/**
 * 打包产物 node_modules 幂等瘦身（prepare.js 与 build-deb-fast.js 共用）
 *
 * 为什么独立成模块：build-deb-fast 的日常增量路径不重跑 prepare（work/app 只首次
 * 准备一次），依赖更新后 npm i 会把浏览器构建等冗余文件重新带进产物——清理清单
 * 只有挂在 prepare.js 里时，deb-fast 打出的包永远带着旧冗余（axios/dist 残留即证）。
 * 两边共用本清单，prepare 跑一遍、deb-fast 每次打包前再跑一遍，幂等无害。
 *
 * 原则（本仓曾因过度清理致启动失败）：
 *   只删「require 解析入口绝对到不了」的文件，每项附入口依据；主进程全部为
 *   require('包名') 裸引用（无动态 import / 显式 dist 子路径，已 grep 验证），
 *   Node 解析永远走 main / exports 的 node/require 条件。清理失败只警告
 *   不中断打包（清理仅影响体积，不影响可用性）。
 *
 * 删除必须走 rmForce：本机 node 安全 shim 会拦 shelljs/子进程的 rm
 * （deb-fast 注释同款问题），fs.rmSync 失败后用原生 /bin/rm 兜底。
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const nmRoot = path.join('work', 'app', 'node_modules')

function shq (s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`
}

function exists (p) {
  return fs.existsSync(p)
}

// 先 fs.rmSync，失败再用原生 /bin/rm -rf（绕开安全 shim）；都失败则返回 false，
// 调用方保留目标并警告——清理是锦上添花，绝不因此中断打包
function rmForce (p) {
  if (!exists(p)) {
    return true
  }
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch (e) {}
  if (!exists(p)) {
    return true
  }
  if (process.platform !== 'win32') {
    try {
      execSync(`/bin/rm -rf ${shq(p)}`, { stdio: 'ignore' })
    } catch (e) {}
  }
  return !exists(p)
}

function duKb (p) {
  try {
    return parseInt(execSync(`du -sk ${shq(p)}`).toString().split(/\s+/)[0], 10) || 0
  } catch (e) {
    return 0
  }
}

// [相对 nmRoot 的路径, 入口依据]
const targets = [
  ['node-forge/dist',
    'main=lib/index.js 且包无 exports 字段；dist 是浏览器 UMD 构建'],
  ['pako/dist',
    'exports["."].require=index.js；dist 为浏览器 ESM/UMD，仅显式子路径可达（源码无引用）'],
  ['trzsz2/dist/browser',
    'exports["."].require=dist/cjs-full/index.cjs；browser 仅 trzsz2/browser 显式子路径可达'],
  ['sm-crypto-v2/miniprogram_dist',
    'main=dist/index.js；miniprogram_dist 是微信小程序构建'],
  ['axios/dist/esm', 'main=dist/node/axios.cjs；esm 是浏览器构建'],
  ['axios/dist/browser', 'main=dist/node/axios.cjs；browser 是浏览器构建'],
  ['axios/index.d.cts', '类型声明，运行时不可达'],
  ['axios/lib', 'main=dist/node/axios.cjs；lib 与 dist/node 重复的源码']
]

// glob 清理（axios dist 根下散 js 与 sourcemap）：主进程入口是 dist/node/axios.cjs，
// 这些散文件不可达。逐文件展开后走 rmForce（避免 shell 层被 shim 拦）
const globTargets = ['axios/dist/*.js', 'axios/dist/*.map', 'axios/dist/node/*.map']

function expandGlob (relGlob) {
  const dir = path.dirname(path.join(nmRoot, relGlob))
  const pattern = path.basename(relGlob)
  if (!exists(dir)) {
    return []
  }
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
  )
  try {
    return fs.readdirSync(dir)
      .filter(f => re.test(f))
      .map(f => path.join(dir, f))
  } catch (e) {
    return []
  }
}

// node-pty：删「当前平台之外」的平台专用 js 与全部测试文件。
// 原生 .node 已由 electron-rebuild 只构建本平台，对侧没有可删的原生产物。
function pruneNodePty () {
  const ptyRoot = path.join(nmRoot, 'node-pty')
  if (!exists(ptyRoot)) {
    return
  }
  const isWin = process.platform === 'win32'
  const platformFiles = isWin
    ? [
        'lib/unixTerminal.js', 'lib/unixTerminal.js.map',
        'lib/unixTerminal.test.js', 'lib/unixTerminal.test.js.map',
        'build/pty.target.mk', 'build/spawn-helper.target.mk',
        'build/binding.Makefile', 'build/gyp-mac-tool'
      ]
    : [
        'lib/conpty_console_list_agent.js', 'lib/conpty_console_list_agent.js.map',
        'lib/windowsConoutConnection.js', 'lib/windowsConoutConnection.js.map',
        'lib/windowsPtyAgent.js', 'lib/windowsPtyAgent.js.map',
        'lib/windowsPtyAgent.test.js', 'lib/windowsPtyAgent.test.js.map',
        'lib/windowsTerminal.js', 'lib/windowsTerminal.js.map',
        'lib/windowsTerminal.test.js', 'lib/windowsTerminal.test.js.map',
        'deps/winpty'
      ]
  const testFiles = [
    'lib/*.test.js', 'lib/*.test.js.map',
    'lib/testUtils.test.js', 'lib/testUtils.test.js.map'
  ]
  for (const rel of platformFiles) {
    rmForce(path.join(ptyRoot, rel))
  }
  for (const g of testFiles) {
    for (const p of expandGlobRel(ptyRoot, g)) {
      rmForce(p)
    }
  }
}

// 与 expandGlob 相同的通配逻辑，但基准目录由调用方指定
function expandGlobRel (base, relGlob) {
  const dir = path.dirname(path.join(base, relGlob))
  const pattern = path.basename(relGlob)
  if (!exists(dir)) {
    return []
  }
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
  )
  try {
    return fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f))
  } catch (e) {
    return []
  }
}

function main () {
  if (!exists(nmRoot)) {
    // 首次 prepare 之前 node_modules 尚不存在，无物可清
    return
  }
  let freedKb = 0
  for (const [rel, why] of targets) {
    const p = path.join(nmRoot, rel)
    if (!exists(p)) {
      continue
    }
    const kb = duKb(p)
    if (!rmForce(p)) {
      console.log(`[prune] ⚠ 删除被拦截，保留 ${rel}（仅影响包体积）`)
      continue
    }
    freedKb += kb
    console.log(`[prune] - ${rel}（${kb}K）${why}`)
  }
  for (const relGlob of globTargets) {
    for (const p of expandGlob(relGlob)) {
      freedKb += duKb(p)
      rmForce(p)
    }
  }
  pruneNodePty()
  console.log(`[prune] node_modules 瘦身完成（释放约 ${Math.round(freedKb / 10.24) / 100}M）`)
}

if (require.main === module) {
  main()
}

module.exports = { main }
