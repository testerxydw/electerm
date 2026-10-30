// G2-4：录制文件列表（组件契约）+ 入口接线
//
// 列表的"算"都发生在 cast-parser 的纯函数里（那边已有单测），
// 这里守的是取数边界与不可逆操作：渲染层不拼路径、探测失败不挡操作、
// 删除必须二次确认且删后重取。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIST = path.join(__dirname, '../../client/components/terminal/recording-list.jsx')
const INFO = path.join(__dirname, '../../client/components/terminal-info/base.jsx')
const extra = require(path.join(__dirname, '../../../src/app/common/locales-extra.js'))

const listSrc = () => fs.readFileSync(LIST, 'utf8')
const infoSrc = () => fs.readFileSync(INFO, 'utf8')

const KEYS = [
  'recordingFiles', 'recDuration', 'recFirstCommand', 'recModified', 'recAction',
  'recShowInFolder', 'recDeleteConfirm', 'recShowFirst', 'recEmptyHint'
]

describe('G2-4 录制列表：取数边界', () => {
  test('目录由主进程算：渲染层只调无目录参数的入口', () => {
    const s = listSrc()
    assert.match(s, /runGlobalAsync\('listRecordings'\)/)
    assert.match(s, /runGlobalAsync\('probeRecordings', names\)/)
    assert.match(s, /runGlobalAsync\('deleteRecording', name\)/)
    assert.match(s, /runGlobalAsync\('showRecordingInFolder', name\)/)
    for (const bad of ['require(', 'fs.', 'path.', 'sessionLogPath']) {
      assert.ok(!s.includes(bad), '渲染层不该出现 ' + bad)
    }
  })

  test('格式解析只走 castProbeSummary（组件里不另起一套 JSON.parse）', () => {
    const s = listSrc()
    assert.match(s, /from '\.\.\/\.\.\/common\/cast-parser\.js'/)
    assert.match(s, /castProbeSummary\(/)
    assert.ok(!s.includes('JSON.parse'), '列表不该自己解析 cast 格式')
  })

  test('探测失败/未探测只标在该行，不挡回放、定位、删除', () => {
    const s = listSrc()
    const ops = s.slice(s.indexOf("title: e('recAction')"), s.indexOf('const hint'))
    assert.ok(ops.includes('setPlay({ name: r.name })'), '回放按钮被探测结果挡掉了')
    assert.ok(ops.includes('reveal(r.name)') && ops.includes('del(r.name)'), '定位/删除缺失')
    assert.ok(!/disabled=/.test(ops), '操作列不该有 disabled（读不出来也要能删）')
  })

  test('删除走二次确认，且删后重取列表而不是本地摘行', () => {
    const s = listSrc()
    assert.match(s, /Popconfirm[\s\S]*?recDeleteConfirm/)
    assert.match(s, /onConfirm=\{\(\) => del\(r\.name\)\}/)
    const del = s.slice(s.indexOf('const del ='), s.indexOf('const columns'))
    assert.ok(del.includes('refresh()'), '删除后必须重取列表')
  })

  test('CDP 自测锚点：条数/总数可读', () => {
    const s = listSrc()
    assert.ok(s.includes('data-rec-count={list.rows.length}'))
    assert.ok(s.includes('data-rec-total={list.total}'))
  })

  test('回放器挂在列表内部（点开即播，不需要父级接线）', () => {
    const s = listSrc()
    assert.match(s, /import CastPlayer from '\.\/cast-player'/)
    assert.match(s, /<CastPlayer[\s\S]*?open=\{!!play\}/)
  })
})

describe('G2-4 入口接线：终端信息面板', () => {
  test('录制区有「录制文件」按钮并打开列表弹层', () => {
    const s = infoSrc()
    assert.match(s, /import RecordingList from '\.\.\/terminal\/recording-list'/)
    assert.match(s, /e\('recordingFiles'\)/)
    assert.match(s, /<RecordingList open=\{this\.state\.recList\}/)
    assert.match(s, /handleToggleRecList/)
  })

  test('样式文件存在且被组件引入', () => {
    assert.ok(fs.existsSync(LIST.replace(/\.jsx$/, '.styl')))
    assert.match(listSrc(), /import '\.\/recording-list\.styl'/)
  })
})

describe('G2-4 文案 en / zh_cn 成对', () => {
  test('守护清单里的 key 两种语言都有', () => {
    const missing = KEYS.filter(k => !(
      Object.prototype.hasOwnProperty.call(extra.en, k) &&
      Object.prototype.hasOwnProperty.call(extra.zh_cn, k)
    ))
    assert.deepEqual(missing, [], 'locales-extra 缺失: ' + missing.join(', '))
  })

  test('组件用到的 rec*/recording* key 全在守护清单里', () => {
    const used = [...listSrc().matchAll(/\be\('(rec[A-Za-z]*|recording[A-Za-z]*)'\)/g)].map(m => m[1])
    const uncovered = [...new Set(used)].filter(k => !KEYS.includes(k))
    assert.deepEqual(uncovered, [], '未守护的 key: ' + uncovered.join(', '))
  })
})
