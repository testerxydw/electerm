/**
 * copy static assets into the built app
 *
 * `work/app/assets` is the web root the packaged app serves (src/app/lib/file-server.js),
 * and the file-manager icons are fetched from `icons/` (src/app/common/runtime-constants.js),
 * so this copy is what makes them exist at runtime.
 *
 * The destination is removed first on purpose: shelljs `cp -r` copies *into* an existing
 * directory, so a second `npm run compile` without a `npm run clean` would create
 * `assets/icons/icons` and then fail. Removing it also drops icons deleted upstream.
 */
const { resolve } = require('path')
const fs = require('fs')
const { cp, rm } = require('shelljs')

const rootPack = resolve(__dirname, '../../../package.json')
const appPack = resolve(__dirname, '../../../work/app/package.json')

// vite 产物按根 package.json 的 version 命名（js/electerm-${version}.js），
// 但运行时 basic.js 用 packInfo.version（= work/app/package.json）拼入口 URL。
// 上游升版本后只跑 compile 而不重新 prepare，两边就会错开：html 是新版、
// basic.js 还在请求旧文件，404 卡死启动页（合并 v5.10.1 时踩过）。
// 只 patch version，保留 prepare 写进 work/app 的 testVersion 等字段。
if (fs.existsSync(appPack)) {
  const root = JSON.parse(fs.readFileSync(rootPack, 'utf8'))
  const built = JSON.parse(fs.readFileSync(appPack, 'utf8'))
  if (built.version !== root.version) {
    built.version = root.version
    fs.writeFileSync(appPack, JSON.stringify(built, null, 2) + '\n')
    console.log('[copy] sync work/app version -> ' + root.version)
  }
}

const from = resolve(
  __dirname,
  '../../../node_modules/electerm-icons/icons'
)
const to = resolve(
  __dirname,
  '../../../work/app/assets/icons'
)

rm('-rf', to)
cp('-r', from, to)
