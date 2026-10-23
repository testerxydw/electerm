/**
 * 构建产物断言：CM6 必须待在异步 chunk 里（设计 §4.7 纪律 2）
 *
 * 为什么需要它：`React.lazy` 只是"声明"了懒加载，一旦有人在主链路里直接
 * `import` 了 db-sql-editor 或 @codemirror/*，vite 会把它拉回主 chunk，
 * 首屏体积悄悄涨 300KB+，而且没人会注意到。这条断言把纪律变成构建失败。
 *
 * 判定口径：
 * - 主入口 js/electerm-*.js 不含 codemirror 特征串
 * - chunk/ 下存在含 codemirror 特征串的异步 chunk（证明代码确实被打进去了，
 *   而不是被 tree-shake 掉、编辑器根本不可用）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const ASSETS = path.join(ROOT, 'work/app/assets')
const JS_DIR = path.join(ASSETS, 'js')
const CHUNK_DIR = path.join(ASSETS, 'chunk')

// 这些串只可能来自 CM6 的运行时（CSS 类名/包名），主入口出现即为泄漏
const MARKERS = ['cm-editor', 'cm-content', '@codemirror/']

function fail (msg) {
  console.error('[check-cm6-chunk] FAIL: ' + msg)
  process.exit(1)
}

function listFiles (dir, filter) {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir)
    .filter(filter)
    .map(name => path.join(dir, name))
}

function hasMarker (file) {
  const text = fs.readFileSync(file, 'utf8')
  return MARKERS.filter(m => text.includes(m))
}

if (!fs.existsSync(ASSETS)) {
  fail(`构建产物不存在：${ASSETS}（先跑 npm run compile）`)
}

const entries = listFiles(JS_DIR, name => /^electerm-.*\.js$/.test(name))
if (!entries.length) {
  fail(`找不到主入口 js/electerm-*.js（看 ${JS_DIR}）`)
}

for (const entry of entries) {
  const hit = hasMarker(entry)
  if (hit.length) {
    fail(`主入口 ${path.basename(entry)} 含 CM6 特征串 [${hit.join(', ')}]，懒加载已失效`)
  }
}

const chunks = listFiles(CHUNK_DIR, name => name.endsWith('.js'))
const editorChunks = chunks
  .map(file => ({ file, hit: hasMarker(file) }))
  .filter(x => x.hit.length)

if (!editorChunks.length) {
  fail('chunk/ 下没有任何含 CM6 的异步 chunk（编辑器可能被整块 tree-shake 掉了）')
}

const total = editorChunks.reduce((n, x) => n + fs.statSync(x.file).size, 0)
const pair = editorChunks.map(x => `${path.basename(x.file)}(${Math.round(fs.statSync(x.file).size / 1024)}KB)`).join(', ')

// 体积红线：CM6 核心 + lang-sql 全量约 400KB 未压缩，gzip 后 ~120KB。
// 超过 900KB 说明重复打包了多份（例如同时有 cjs/esm 两个入口）
if (total > 900 * 1024) {
  fail(`CM6 chunk 体积 ${Math.round(total / 1024)}KB 超过 900KB 上限，疑似重复打包`)
}

console.log(`[check-cm6-chunk] OK: 主入口干净，CM6 在 ${pair}，合计 ${Math.round(total / 1024)}KB`)
