/**
 * agent ESM 沙箱夹具 —— 在 Node 里直连加载渲染层 ESM 链（agent.js 一族）。
 *
 * 为什么需要它：`agent.js`/`agent-tools.js` 的 import 都不带 `.js` 扩展名
 * （bundler 会解析，Node 不会），直接 `import` 报 `ERR_MODULE_NOT_FOUND`，
 * 于是行为级测试只能靠源码抽取 —— 抽取测不了 run 循环、路由、取消这些
 * **行为**。本夹具把 import 闭包整体拷到 `os.tmpdir()`、给相对 import 补上
 * `.js`，再用 `pathToFileURL` 动态 import：代码逐字节同源（只改了 specifier），
 * 行为即源码行为。每次调用都从**当前盘上源码**重建，源码一改测试自动跟上。
 *
 * teardown：`cleanup()` 用 `rmSync` 删临时目录（模块已加载进内存，删除无碍）。
 * 注意本仓库环境 shell 的 `rm` 被安全垫片拦，夹具内部一律走 `fs.rmSync`。
 */

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

/**
 * 解析一个相对 specifier（Electron/bundler 语义：无扩展名时依次试 .js/.jsx/index.js）。
 * @param {string} fromFile
 * @param {string} spec
 * @returns {string|null}
 */
function resolveSpec (fromFile, spec) {
  if (!spec.startsWith('.')) {
    return null
  }
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [base, base + '.js', base + '.jsx', path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

/**
 * 从入口出发遍历静态 import 闭包（裸包名导入不是相对路径，保持原样）。
 * @param {string} entry
 * @returns {Set<string>}
 */
function walkGraph (entry) {
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) {
      return
    }
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    const re = /(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]/g
    let match
    while ((match = re.exec(source)) !== null) {
      const resolved = resolveSpec(file, match[1])
      if (resolved && resolved.endsWith('.js')) {
        walk(resolved)
      }
    }
  }
  walk(entry)
  return seen
}

/**
 * 给相对 specifier 补 `.js`（已带扩展名的原样保留）。
 * @param {string} source
 * @returns {string}
 */
function rewriteSpecifiers (source) {
  return source.replace(/(from\s+')(\.[^']+)(')/g, (whole, head, spec, tail) => (
    spec.endsWith('.js') ? whole : head + spec + '.js' + tail
  ))
}

/**
 * 删整棵临时树。`fs.rmSync` 在本开发环境被安全垫片拦到回收站，其 trash
 * helper 会握住继承的 stdio 管道 —— 测试管线（管道/后台任务）会被整体挂死。
 * 所以这里**只逐个 unlink 文件**（unlinkSync 不走回收站流程）；目录本身：
 * `CODEBUDDY_SAFE_DELETE_ENABLED` 未设置（即真实 CI / gate 命令 `env -u …`）
 * 时用 rmSync 深删，垫片激活时跳过目录删除 —— 沙箱建在
 * `node_modules/.cache/` 下，空目录对 git 不可见、对构建无影响。
 * @param {string} dir
 * @param {Array<string>} createdFiles 绝对路径清单
 * @returns {void}
 */
function cleanupSandbox (dir, createdFiles) {
  for (const file of createdFiles) {
    try {
      fs.unlinkSync(file)
    } catch (_) {
      // already gone
    }
  }
  if (process.env.CODEBUDDY_SAFE_DELETE_ENABLED) {
    // 垫片激活的开发机：留空目录，不碰 rmSync/rmdir（会挂管线）。
    return
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_) {
    // best effort
  }
}

/**
 * 拷贝 agent.js 的 import 闭包到临时目录并返回可 import 的 URL。
 *
 * 沙箱目录必须落在**仓库内**（`node_modules/.cache/` 下）：闭包里有裸包名
 * 导入（`uid.js` → `nanoid`），Node 的 node_modules 解析逐级向上，放到
 * /tmp 就断了；`.cache/` 又保证沙箱对 git 不可见。
 * @param {string} [entry] 入口文件绝对路径，默认 agent.js
 * @returns {{url: string, dir: string, cleanup: Function}}
 */
function buildAgentSandbox (entry) {
  const entryFile = entry || path.resolve(__dirname, '../../client/components/ai/agent.js')
  const repoRoot = path.resolve(__dirname, '../..')
  const files = walkGraph(entryFile)
  const cacheRoot = path.join(repoRoot, 'node_modules', '.cache')
  fs.mkdirSync(cacheRoot, { recursive: true })
  const tmpRoot = fs.mkdtempSync(path.join(cacheRoot, 'agent-esm-sandbox-'))
  const created = []
  for (const file of files) {
    const rel = path.relative(repoRoot, file)
    const target = path.join(tmpRoot, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, rewriteSpecifiers(fs.readFileSync(file, 'utf8')))
    created.push(target)
  }
  const relEntry = path.relative(repoRoot, entryFile)
  return {
    url: pathToFileURL(path.join(tmpRoot, relEntry)).href,
    dir: tmpRoot,
    cleanup: () => cleanupSandbox(tmpRoot, created)
  }
}

module.exports = { buildAgentSandbox, rewriteSpecifiers, walkGraph }
