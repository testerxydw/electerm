/**
 * 构建版本单一真源：vite 产物名（pug.js / vite）与运行时入口 URL
 * （basic.js 读 packInfo.version = work/app/package.json）必须用同一个版本号。
 *
 * 2026-11-13 合并上游 v5.10.1 时踩过：根 package.json 升到 5.10.1，
 * work/app/package.json 仍是 5.10.0，basic.js 请求 js/electerm-5.10.0.js
 * 得到 404 —— html 正常但入口没跑，window.store 永远 undefined，
 * 表现为「启动页卡死」，且 op 级探针（只走 window.pre）测不出来。
 * 治本逻辑放在 build/bin/copy.js：每次 compile 同步 version。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const rootPack = require(path.join(ROOT, 'package.json'))

describe('build version sync: 产物名与运行时入口同源', () => {
  it('basic.js 用 packInfo.version 拼入口 URL', () => {
    assert.match(read('src/client/entry/basic.js'), /packInfo\.version|version/)
    assert.match(read('src/client/entry/basic.js'), /js\/electerm-\$\{version\}\.js/)
  })

  it('pug.js 按根 package.json 的 version 生成 html/preload', () => {
    const src = read('src/build/bin/pug.js')
    assert.match(src, /require\('\.\.\/\.\.\/\.\.\/package\.json'\)/)
    assert.match(src, /version: pack\.version/)
  })

  it('copy.js 每次编译都把根 version 同步进 work/app，不覆盖其它字段', () => {
    const src = read('src/build/bin/copy.js')
    assert.match(src, /built\.version !== root\.version/)
    assert.match(src, /built\.version = root\.version/)
    assert.match(src, /JSON\.parse\(fs\.readFileSync\(appPack/)
    assert.match(src, /fs\.writeFileSync\(appPack/)
  })

  it('已编译产物存在时，work/app/package.json 的 version 必须与根一致', () => {
    const appPack = path.join(ROOT, 'work/app/package.json')
    if (!fs.existsSync(appPack)) {
      return // 干净 CI 未跑过 prepare，没有可比对的产物
    }
    const built = JSON.parse(fs.readFileSync(appPack, 'utf8'))
    assert.equal(built.version, rootPack.version,
      '版本错开会让 basic.js 请求不存在的入口 js，页面 404 卡启动页')
  })
})
