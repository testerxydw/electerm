/**
 * multi language support
 */

const { isDev, defaultLang } = require('../common/runtime-constants')
const { resolve } = require('path')
const localesExtra = require('../common/locales-extra')

/**
 * 合并本地补充词条（src/app/common/locales-extra.js）。
 * 语言包 @electerm/electerm-locales 是外部依赖，无法就地新增 key，
 * 缺失时 translate() 会直接返回 key 原文；这里：
 *   1. 先用英文兜底补齐所有语言缺失项；
 *   2. 再用该语言自己的词条覆盖；
 *   3. 语言包已有翻译始终优先（只补缺失，不覆盖上游）。
 * 合并在主进程完成 → 主进程菜单与渲染进程共用同一 langMap，天然一致。
 */
function applyExtraLang (id, lang) {
  const res = { ...lang }
  for (const [k, v] of Object.entries(localesExtra.en)) {
    if (res[k] === undefined) {
      res[k] = v
    }
  }
  const own = localesExtra[id]
  if (own) {
    for (const [k, v] of Object.entries(own)) {
      // 判断语言包原值，而不是已被英文兜底填过的 res
      if (lang[k] === undefined) {
        res[k] = v
      }
    }
  }
  return res
}

function getOsLocale () {
  return require('os-locale-s')
    .osLocale()
    .catch(() => '')
}

async function loadLocales () {
  const sysLocale = await getOsLocale() || defaultLang
  const path = (isDev
    ? '../../'
    : '') +
    '../node_modules/@electerm/electerm-locales/dist/cjs'
  const localeFolder = resolve(__dirname, path)
  // languages array
  const langs = require(resolve(localeFolder, 'list.json'))
    .map(fileName => {
      const filePath = resolve(localeFolder, fileName)
      const raw = require(filePath)
      const id = fileName.replace('.js', '')
      return {
        path: filePath,
        id,
        name: raw.name,
        reg: raw.match,
        lang: applyExtraLang(id, raw.lang)
      }
    })
  const langMap = langs.reduce((prev, l) => {
    prev[l.id] = l
    return prev
  }, {})
  return {
    langs,
    langMap,
    sysLocale
  }
}

function findLang (langs, la) {
  let res = false
  for (const l of langs) {
    res = new RegExp(l.reg).test(la)
    if (res) {
      res = l.id
      break
    }
  }
  return res
}

const getLang = (config, sysLocale, langs) => {
  if (config.language) {
    return config.language
  }
  let l = sysLocale
  l = l ? l.toLowerCase().replace('-', '_') : defaultLang
  return findLang(langs, l) || defaultLang
}

exports.getLang = getLang
exports.loadLocales = loadLocales
