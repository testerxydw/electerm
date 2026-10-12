/**
 * Patch node_modules/@electerm/electerm-locales 新增翻译 key
 * - 需要给上游发 PR 合并后删除此脚本
 * - npm install 后自动运行 (package.json postinstall)
 */

const fs = require('fs')
const path = require('path')

// 格式: langCode → { key: value }
// en_us 是其他语言的参考基准, key 顺序与 en_us 保持一致
const additions = {
  en_us: {
    splitHorizontal: 'split horizontally',
    splitVertical: 'split vertically',
    cannotSplitFurther: 'already at max layout, cannot split further',
    moveToPane: 'move to pane',
    terminalLog: 'Terminal Log',
    restoreLastSession: 'Restore last session on start'
  },
  zh_cn: {
    splitHorizontal: '水平拆分',
    splitVertical: '垂直拆分',
    cannotSplitFurther: '已到最大布局, 无法继续拆分',
    moveToPane: '迁移到窗格',
    terminalLog: '终端日志',
    restoreLastSession: '启动时恢复上次会话'
  },
  zh_tw: {
    splitHorizontal: '水平拆分',
    splitVertical: '垂直拆分',
    cannotSplitFurther: '已到最大布局, 無法繼續拆分',
    moveToPane: '遷移到窗格',
    terminalLog: '終端日誌',
    restoreLastSession: '啟動時恢復上次會話'
  },
  // 其他语言 fallback 到英文
  ar_ar: null,
  de_de: null,
  es_es: null,
  fr_fr: null,
  hu_hu: null,
  id_id: null,
  ja_jp: null,
  ko_kr: null,
  pl_pl: null,
  pt_br: null,
  ru_ru: null,
  tr_tr: null
}

// 覆盖上游已有 key 的翻译 (force 替换, 不影响 en_us/其他语言)
// newTab 实为"打开本地终端", 上游 zh_cn 译"新建连接"易误解为新建 SSH
const overrides = {
  zh_cn: {
    newTab: '本地终端'
  }
}

function patchOne (filePath, dict, force = false) {
  if (!fs.existsSync(filePath)) {
    console.log('[patch-locales] skip, not found:', filePath)
    return
  }
  let content = fs.readFileSync(filePath, 'utf8')
  // key 已存在时: force 模式覆盖值, 否则跳过 (增量 patch)
  // key 匹配兼容单/双引号值 (历史 append 产物为双引号, 不兼容会破坏幂等导致重复插入)
  // key 前界定为 , 或 { 避免误匹配其他含该子串的 key
  // 全局替换: cjs (module.exports/exports.default) 与 mjs (export const/default) 含多份对象, 需同步 patch
  const append = []
  for (const [k, v] of Object.entries(dict)) {
    const testRe = new RegExp(`([,{])${k}:(?:'[^']*'|"[^"]*")`)
    if (testRe.test(content)) {
      if (force) {
        const re = new RegExp(`([,{])${k}:(?:'[^']*'|"[^"]*")`, 'g')
        content = content.replace(re, `$1${k}:${JSON.stringify(v)}`)
      }
    } else {
      append.push([k, v])
    }
  }
  if (!append.length) {
    if (force) {
      fs.writeFileSync(filePath, content)
      console.log('[patch-locales] overridden:', path.basename(filePath))
    }
    return
  }
  // minified 单行格式: ...,moveToFooter:'move to footer'},name:'English',...
  // 插入到最后一个 lang key 之后, name/match/flag 之前
  // append 用单引号写入 (与文件风格一致, 保证脚本幂等)
  const quote = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
  const dictStr = append
    .map(([k, v]) => `${k}:${quote(v)}`)
    .join(',')
  // 找 },name: 分界点
  const marker = /\},name:'/g
  if (!marker.test(content)) {
    console.log('[patch-locales] skip, unexpected format:', filePath)
    return
  }
  content = content.replace(marker, `,${dictStr}},name:'`)
  fs.writeFileSync(filePath, content)
  console.log('[patch-locales] patched:', path.basename(filePath))
}

function run () {
  const roots = [
    path.resolve(__dirname, '..', '..'), // 项目根 node_modules (本文件位于 src/build/ 下, 需上两级)
    path.resolve(__dirname, '..', '..', 'work/app') // bdebfast 打包用的独立 node_modules
  ]
  let patchedAny = false
  for (const root of roots) {
    const locales = path.join(root, 'node_modules/@electerm/electerm-locales')
    if (!fs.existsSync(locales)) {
      console.log('[patch-locales] skip, not found:', locales)
      continue
    }
    patchedAny = true
    const cjsDir = path.join(locales, 'dist/cjs')
    const esmDir = path.join(locales, 'dist/esm')
    for (const [code, dict] of Object.entries(additions)) {
      const realDict = dict || additions.en_us
      patchOne(path.join(cjsDir, `${code}.js`), realDict)
      patchOne(path.join(esmDir, `${code}.mjs`), realDict)
    }
    for (const [code, dict] of Object.entries(overrides)) {
      patchOne(path.join(cjsDir, `${code}.js`), dict, true)
      patchOne(path.join(esmDir, `${code}.mjs`), dict, true)
    }
  }
  if (!patchedAny) {
    console.log('[patch-locales] skip, electerm-locales not installed in any location')
  } else {
    console.log('[patch-locales] done')
  }
}

run()
