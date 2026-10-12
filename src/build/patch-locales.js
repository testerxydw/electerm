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
    moveToPane: 'move to pane'
  },
  zh_cn: {
    splitHorizontal: '水平拆分',
    splitVertical: '垂直拆分',
    cannotSplitFurther: '已到最大布局, 无法继续拆分',
    moveToPane: '迁移到窗格'
  },
  zh_tw: {
    splitHorizontal: '水平拆分',
    splitVertical: '垂直拆分',
    cannotSplitFurther: '已到最大布局, 無法繼續拆分',
    moveToPane: '遷移到窗格'
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

function patchOne (filePath, dict) {
  if (!fs.existsSync(filePath)) {
    console.log('[patch-locales] skip, not found:', filePath)
    return
  }
  const content = fs.readFileSync(filePath, 'utf8')
  // 增量 patch: 只补缺失的 key, 已 patch 文件可追加新 key
  const missing = Object.entries(dict).filter(([k]) => !content.includes(`${k}:`))
  if (!missing.length) {
    return
  }
  // minified 单行格式: ...,moveToFooter:'move to footer'},name:'English',...
  // 插入到最后一个 lang key 之后, name/match/flag 之前
  const dictStr = missing
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join(',')
  // 找 },name: 分界点
  const marker = /\},name:'/
  if (!marker.test(content)) {
    console.log('[patch-locales] skip, unexpected format:', filePath)
    return
  }
  const patched = content.replace(marker, `,${dictStr}},name:'`)
  fs.writeFileSync(filePath, patched)
  console.log('[patch-locales] patched:', path.basename(filePath))
}

function run () {
  const roots = [
    path.resolve(__dirname, '..'), // 项目根 node_modules
    path.resolve(__dirname, '..', 'work/app') // bdebfast 打包用的独立 node_modules
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
  }
  if (!patchedAny) {
    console.log('[patch-locales] skip, electerm-locales not installed in any location')
  } else {
    console.log('[patch-locales] done')
  }
}

run()
