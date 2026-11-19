/**
 * 打包前同步语言包版本：检测 @electerm/electerm-locales 的 npm 最新版，
 * 若高于本地锁定版本则 bump package.json 精确版本 + package-lock.json。
 *
 * 背景：翻译真相源在独立仓库 electerm/electerm-locales，发布为 npm 包。
 * 本 fork 在 package.json 用**精确版本**锁定，打包脚本只装锁版本，
 * 上游发新版后不会自动拿到（--prepare 也只是重装同一锁版本）。
 * 本脚本补上「检测新版 → bump 本地锁」这一环：bump 后 build-deb-fast
 * 的依赖指纹变化会触发 prepare，重装新语言包，随后 patch-locales 补本地词。
 *
 * 设计纪律：
 *   1. 国内镜像优先（registry.npmmirror.com），失败回落官方 registry。
 *   2. 精确版本 bump（不带 ^），与现有锁定口径一致。
 *   3. 任何失败（离线/超时/未知版本）都只警告、退出码 0，绝不阻断打包。
 *   4. 纯函数导出，CLI 副作用只在 require.main 下执行，供契约测试直接 require。
 *
 * 用法：
 *   node src/build/bin/sync-locales.js            # 检测并按需 bump
 *   node src/build/bin/sync-locales.js --dry-run   # 只报告，不改文件
 *   --no-sync-locales 由 build-deb-fast 透传跳过（见该脚本）
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const PKG_NAME = '@electerm/electerm-locales'
const PKG_PATH = path.join(ROOT, 'package.json')
const LOCK_PATH = path.join(ROOT, 'package-lock.json')
const REGISTRIES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org'
]

/**
 * 版本号比较（纯函数，不依赖 semver 包，避免构建链额外依赖）。
 * 只处理数字点分版本（2.3.39），忽略 prerelease 尾巴；无法解析返回 null。
 * @returns {number[]|null}
 */
function parseVersion (v) {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * 比较 a > b（纯函数）。版本非法返回 false（保守，不 bump）。
 */
function isNewer (a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return false
}

/**
 * 从 npm view 的原始输出解析出版本号（纯函数）。
 * npm view 可能返回多行/带 notes，取第一行合法版本。
 */
function parseLatestOutput (out) {
  if (typeof out !== 'string') return null
  for (const line of out.split('\n')) {
    const v = parseVersion(line)
    if (v) return line.trim().replace(/^v/, '')
  }
  return null
}

/**
 * 查询最新版：国内镜像优先，失败回落官方。返回 { version, registry } 或 null。
 * 注入 exec 便于测试。
 */
function queryLatest (exec = execFileSync, registries = REGISTRIES) {
  const errors = []
  for (const registry of registries) {
    try {
      const out = exec('npm', [
        'view', PKG_NAME, 'version', '--registry=' + registry
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const version = parseLatestOutput(out)
      if (version) return { version, registry }
      errors.push(`${registry}: 无法解析版本 "${String(out).trim()}"`)
    } catch (e) {
      errors.push(`${registry}: ${e.message.split('\n')[0]}`)
    }
  }
  return { error: errors.join(' | ') }
}

function readJson (p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/**
 * 生成同步决策（纯函数）：给定本地版本与远端版本，返回是否 bump。
 */
function decide (localVersion, latestVersion) {
  if (!latestVersion) {
    return { action: 'skip', reason: 'no-latest' }
  }
  if (!localVersion) {
    return { action: 'skip', reason: 'no-local' }
  }
  if (isNewer(latestVersion, localVersion)) {
    return { action: 'bump', from: localVersion, to: latestVersion }
  }
  return { action: 'current', version: localVersion }
}

/**
 * CLI 主流程。返回结构化结果，不抛异常（失败降级）。
 * 依赖可通过 opts 注入以便测试（fs/exec/路径/registry）。
 */
function run (opts = {}) {
  const config = {
    pkgPath: opts.pkgPath || PKG_PATH,
    lockPath: opts.lockPath || LOCK_PATH,
    dryRun: !!opts.dryRun,
    exec: opts.exec || execFileSync,
    registries: opts.registries || REGISTRIES,
    log: opts.log || (s => process.stdout.write(s + '\n'))
  }
  const log = config.log
  let localVersion
  try {
    localVersion = readJson(config.pkgPath).dependencies?.[PKG_NAME]
  } catch (e) {
    log(`[sync-locales] 读取 package.json 失败，跳过：${e.message}`)
    return { action: 'skip', reason: 'read-error' }
  }

  const remote = queryLatest(config.exec, config.registries)
  if (remote.error || !remote.version) {
    log(`[sync-locales] 查询最新版失败，沿用本地锁 ${localVersion || '?'}：${remote.error || 'no version'}`)
    return { action: 'skip', reason: 'query-failed', localVersion }
  }
  log(`[sync-locales] 本地 ${localVersion || '?'} / 最新 ${remote.version}（${remote.registry}）`)

  const decision = decide(localVersion, remote.version)
  if (decision.action !== 'bump') {
    log(`[sync-locales] ${decision.action === 'current' ? '已是最新' : '无本地版本'}，无需 bump`)
    return decision
  }

  log(`[sync-locales] 发现新版：${decision.from} → ${decision.to}`)
  if (config.dryRun) {
    log('[sync-locales] --dry-run：仅报告，不修改文件')
    return { ...decision, dryRun: true }
  }

  try {
    // 1. bump package.json 精确版本（保留其余字段与缩进风格）
    const pkg = readJson(config.pkgPath)
    pkg.dependencies[PKG_NAME] = decision.to
    fs.writeFileSync(config.pkgPath, JSON.stringify(pkg, null, 2) + '\n')

    // 2. 同步 package-lock.json（--package-lock-only 不装包、不跑脚本）
    config.exec('npm', [
      'install', '--package-lock-only', '--ignore-scripts',
      '--registry=' + remote.registry
    ], { cwd: ROOT, stdio: 'ignore' })

    log('[sync-locales] 已 bump package.json + package-lock.json，打包将触发 prepare 重装新语言包')
    return { ...decision, synced: true, registry: remote.registry }
  } catch (e) {
    log(`[sync-locales] bump 失败（不阻断打包）：${e.message}`)
    return { ...decision, synced: false, error: e.message }
  }
}

module.exports = {
  PKG_NAME,
  REGISTRIES,
  parseVersion,
  isNewer,
  parseLatestOutput,
  queryLatest,
  decide,
  run
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run')
  try {
    run({ dryRun })
  } catch (e) {
    // 兜底：任何未预料异常都不能让打包脚本失败
    process.stdout.write(`[sync-locales] 未预期异常，跳过（不阻断打包）：${e.message}\n`)
  }
}
