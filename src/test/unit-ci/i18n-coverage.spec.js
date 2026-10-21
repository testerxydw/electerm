// 批次 A 守护：客户端所有字面量翻译 key 必须有词条；组件内不得直写中文 UI 文案
// 词条来源 = 上游语言包（en/zh_cn）+ 本地补充（locales-extra.js）
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const CLIENT = path.join(ROOT, 'src/client')
const COMPONENTS = path.join(CLIENT, 'components')
const extra = require(path.join(ROOT, 'src/app/common/locales-extra.js'))
const zh = require(path.join(ROOT, 'node_modules/@electerm/electerm-locales/dist/cjs/zh_cn.js')).lang
const en = require(path.join(ROOT, 'node_modules/@electerm/electerm-locales/dist/cjs/en_us.js')).lang

const hasKey = key => (
  Object.prototype.hasOwnProperty.call(zh, key) ||
  Object.prototype.hasOwnProperty.call(en, key) ||
  Object.prototype.hasOwnProperty.call(extra.en, key) ||
  Object.prototype.hasOwnProperty.call(extra.zh_cn, key)
)

function walk (dir, extRe, fn) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) {
      walk(p, extRe, fn)
    } else if (extRe.test(f.name)) {
      fn(p, fs.readFileSync(p, 'utf8'))
    }
  }
}

function collectKeys (re) {
  const keys = new Set()
  walk(CLIENT, /\.(jsx|js)$/, (file, src) => {
    for (const m of src.matchAll(re)) {
      keys.add(m[1])
    }
  })
  return keys
}

describe('批次 A i18n coverage', () => {
  test('e() / translateOr() 的字面量 key 均有词条', () => {
    const groups = [
      { name: 'e()', keys: collectKeys(/\be\(\s*['"]([^'"]+)['"]\s*\)/g) },
      { name: 'translateOr()', keys: collectKeys(/translateOr\(\s*['"]([^'"]+)['"]/g) }
    ]
    for (const { name, keys } of groups) {
      const missing = [...keys].filter(k => !hasKey(k))
      assert.deepEqual(missing, [], name + ' missing translations: ' + missing.join(', '))
    }
  })

  test('组件不直写中文 title / placeholder / description', () => {
    const re = /(?:title|placeholder|description)='[^']*[\u4e00-\u9fff][^']*'/
    const bad = []
    walk(COMPONENTS, /\.jsx$/, (file, src) => {
      if (re.test(src)) {
        bad.push(path.relative(ROOT, file))
      }
    })
    assert.deepEqual(bad, [], 'hardcoded Chinese props: ' + bad.join(', '))
  })

  test('组件不直写中文 JSX 文本节点', () => {
    const re = />\s*[\u4e00-\u9fff][^<{]*</
    const bad = []
    walk(COMPONENTS, /\.jsx$/, (file, src) => {
      if (re.test(src)) {
        bad.push(path.relative(ROOT, file))
      }
    })
    assert.deepEqual(bad, [], 'hardcoded Chinese JSX text: ' + bad.join(', '))
  })

  test('快捷命令与通用 UI 新增词条 en / zh_cn 成对存在', () => {
    const keys = [
      'noLabel', 'enterValue', 'sendToAllTerminals', 'recordedQuickCommand',
      'steps', 'saveRecording', 'cancelRecording', 'runInTerminals',
      'waitingFor', 'waitingForInput', 'stopQuickCommand', 'stop',
      'waitForText', 'askForInput', 'run', 'recordQuickCommand',
      'groupByLabel', 'inputHidden', 'inputShown', 'textToWaitFor',
      'questionToAsk', 'repeat', 'waitTimeout', 'delayBeforeStep',
      'insertAbove', 'insertBelow', 'waitTimedOut', 'nothingRecorded',
      'transferPanel', 'monitorPanel', 'sessionList', 'actionList',
      'commandPalette', 'commandPaletteHint', 'noMatches',
      'systemLoad', 'monitorConnecting', 'systemSchemas',
      'systemSchemasHint', 'showMore', 'showLess', 'selectFilePath',
      'transferEmpty', 'monitorOffHint'
    ]
    const missing = keys.filter(k => !(
      Object.prototype.hasOwnProperty.call(extra.en, k) &&
      Object.prototype.hasOwnProperty.call(extra.zh_cn, k)
    ))
    assert.deepEqual(missing, [], 'keys missing in extra en/zh_cn: ' + missing.join(', '))
  })
})
