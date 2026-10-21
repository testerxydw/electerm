// T8 数据库页文案 i18n 回归：
//  - 新增词条在 en / zh_cn 均存在
//  - 页面源码不再出现已列出的英文硬编码
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const VALUE_PANE = path.join(ROOT, 'src/client/components/database/db-value-pane.jsx')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

describe('T8 database page i18n', () => {
  test('词条在 en / zh_cn 各出现一次', () => {
    const locales = read(LOCALES)
    const keys = [
      'dbLoading',
      'dbPageLabel',
      'dbPagePlaceholder',
      'dbGo',
      'dbRowsPerPage',
      'dbSelectCell',
      'dbSelectKey',
      'dbSqlPlaceholder',
      'dbRun',
      'dbReadOnly',
      'dbLoadMore',
      'dbLeft',
      'dbSetTtl',
      'dbDeleteKey',
      'dbDelete',
      'dbField',
      'dbValue',
      'dbMember',
      'dbScore',
      'dbKey',
      'dbTtl',
      'dbTypeMeta',
      'dbTtlMeta',
      'dbNone',
      'dbChars',
      'dbUnsupportedType',
      'dbMatchPlaceholder',
      'dbDragResize',
      'dbDeleted',
      'dbTtlUpdated',
      'dbPreviewHint',
      'dbPreviewEditHint',
      'dbResultN',
      'dbAffectedRows',
      'dbSeconds',
      'dbSelectDb',
      'dbNoMetadata',
      'dbDataTab',
      'dbPerPage'
    ]
    keys.forEach(key => {
      const hits = locales.match(new RegExp('\\b' + key + ':', 'g')) || []
      assert.equal(hits.length, 2, key + ' must exist in both en and zh_cn')
    })
  })

  test('db-session.jsx 不再包含已清理的英文硬编码', () => {
    const src = read(SESSION)
    const leftovers = [
      'loading database...',
      'select a cell to preview',
      'select a key',
      'load more (left',
      '>set ttl<',
      'delete this key?',
      'match pattern, e.g. user:*',
      'affected rows: ',
      '>read-only<',
      '>run<',
      '>go<',
      "title='rows per page'",
      "placeholder='seconds'",
      "title='drag to resize'",
      'unsupported type: ',
      "'click to preview'",
      'page {grid.page}',
      'page {keyList.stack.length + 1}'
    ]
    leftovers.forEach(s => {
      assert.ok(!src.includes(s), 'hardcoded copy remains: ' + s)
    })
  })

  test('复用上游词条（copy/edit/save/cancel/close）而非硬编码', () => {
    const src = read(VALUE_PANE)
    assert.ok(src.includes("title={e('copy')}"), 'copy tooltip must use translate')
    assert.ok(src.includes("{e('save')}"), 'save label must use translate')
    assert.ok(src.includes("{e('cancel')}"), 'cancel label must use translate')
    assert.ok(src.includes("{e('edit')}"), 'edit label must use translate')
    assert.ok(src.includes("title={e('close')}"), 'close tooltip must use translate')
    assert.ok(src.includes("e('rawText')"), 'raw format label must use translate')
  })
})
