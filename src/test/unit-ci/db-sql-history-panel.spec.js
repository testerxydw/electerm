// SQL 历史弹层几何（阶段4 交互改进）：纯函数直测
// 尺寸要能拖、要持久化、要按视口夹取——这些边界在 DOM 里很难复现（窗口大小、
// 旧配置残留、拖到负值），所以逻辑全部放纯函数，这里逐个钉死。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = path.join(__dirname, '../../client/common/db-sql-history-panel.js')

function loadFns () {
  let src = fs.readFileSync(SRC, 'utf8')
  src = src.replace(/^export /gm, '')
  const sandbox = {}
  vm.createContext(sandbox)
  return vm.runInContext(
    `(function () { ${src}; return {
      HIST_PANEL_DEF, HIST_PANEL_MIN, HIST_PANEL_MAX, HIST_SPLIT_MIN_WIDTH,
      clampPanelSize, readHistoryPanelSize, sizePatch, splitMode,
      moveHistoryIndex, clampHistoryIndex, previewText, filterHistory
    } })()`,
    sandbox
  )
}

describe('db-sql-history-panel: 尺寸夹取', () => {
  const f = loadFns()

  test('缺省/非法值回落到默认尺寸', () => {
    for (const size of [undefined, null, {}, { width: 'abc' }, { width: NaN }]) {
      const s = f.clampPanelSize(size, { width: 1600, height: 1000 })
      assert.deepEqual(
        [s.width, s.height],
        [f.HIST_PANEL_DEF.width, f.HIST_PANEL_DEF.height]
      )
    }
  })

  test('拖到负值/极小值不会塌陷（夹到下限）', () => {
    const s = f.clampPanelSize({ width: -300, height: 1 }, { width: 1600, height: 1000 })
    assert.equal(s.width, f.HIST_PANEL_MIN.width)
    assert.equal(s.height, f.HIST_PANEL_MIN.height)
  })

  test('拖到超大值按上限夹（不超过视口，否则够不着列表底部）', () => {
    const s = f.clampPanelSize({ width: 9999, height: 9999 }, { width: 1280, height: 800 })
    assert.equal(s.width, Math.min(f.HIST_PANEL_MAX.width, 1280 - 48))
    assert.equal(s.height, Math.min(f.HIST_PANEL_MAX.height, 800 - 220))
  })

  test('大窗口下上限就是设计上限（不无限放大成遮罩）', () => {
    const s = f.clampPanelSize({ width: 9999, height: 9999 }, { width: 3440, height: 1440 })
    assert.equal(s.width, f.HIST_PANEL_MAX.width)
    assert.equal(s.height, f.HIST_PANEL_MAX.height)
  })

  test('窗口比下限还小时仍然返回合法正尺寸（不返回负/NaN）', () => {
    const s = f.clampPanelSize({ width: 700, height: 500 }, { width: 300, height: 200 })
    assert.equal(s.width, f.HIST_PANEL_MIN.width)
    assert.equal(s.height, f.HIST_PANEL_MIN.height)
  })

  test('结果取整（拖拽会产生小数像素）', () => {
    const s = f.clampPanelSize({ width: 700.6, height: 400.2 }, { width: 1600, height: 1000 })
    assert.equal(Number.isInteger(s.width), true)
    assert.equal(Number.isInteger(s.height), true)
  })
})

describe('db-sql-history-panel: 读写配置', () => {
  const f = loadFns()

  test('读 config：没有就直接用默认', () => {
    const s = f.readHistoryPanelSize(undefined, { width: 1600, height: 1000 })
    assert.equal(s.width, f.HIST_PANEL_DEF.width)
  })

  test('读 config：数字字符串也认（手改 config 很常见）', () => {
    const s = f.readHistoryPanelSize(
      { dbSqlHistoryWidth: '640', dbSqlHistoryHeight: 500 },
      { width: 1600, height: 1000 }
    )
    assert.deepEqual([s.width, s.height], [640, 500])
  })

  test('读 config：超范围值一律夹住（旧配置可能来自更大的窗口）', () => {
    const s = f.readHistoryPanelSize(
      { dbSqlHistoryWidth: 5000, dbSqlHistoryHeight: 10 },
      { width: 1280, height: 800 }
    )
    assert.equal(s.width, Math.min(f.HIST_PANEL_MAX.width, 1280 - 48))
    assert.equal(s.height, f.HIST_PANEL_MIN.height)
  })

  test('落盘补丁只含两个尺寸键（setConfig 是浅合并，不能整份写回）', () => {
    const p = f.sizePatch({ width: 640, height: 420 })
    assert.deepEqual(Array.from(Object.keys(p)).sort(), ['dbSqlHistoryHeight', 'dbSqlHistoryWidth'])
    assert.equal(p.dbSqlHistoryWidth, 640)
    assert.equal(p.dbSqlHistoryHeight, 420)
  })
})

describe('db-sql-history-panel: 分栏', () => {
  const f = loadFns()

  test('够宽左右排，窄了上下叠', () => {
    assert.equal(f.splitMode(f.HIST_SPLIT_MIN_WIDTH), 'row')
    assert.equal(f.splitMode(f.HIST_SPLIT_MIN_WIDTH - 1), 'col')
  })

  test('非法宽度按上下处理（宁窄不宽，别把预览挤成 0）', () => {
    assert.equal(f.splitMode(undefined), 'col')
    assert.equal(f.splitMode('x'), 'col')
  })
})

describe('db-sql-history-panel: 键盘导航', () => {
  const f = loadFns()

  test('未选中时按下 → 第一条，按上 → 最后一条', () => {
    assert.equal(f.moveHistoryIndex(null, 5, 1), 0)
    assert.equal(f.moveHistoryIndex(null, 5, -1), 4)
  })

  test('越界回绕（从最后一条再按下回到最新）', () => {
    assert.equal(f.moveHistoryIndex(4, 5, 1), 0)
    assert.equal(f.moveHistoryIndex(0, 5, -1), 4)
  })

  test('空列表返回 0（不返回 NaN/负值）', () => {
    assert.equal(f.moveHistoryIndex(3, 0, 1), 0)
  })

  test('下标夹取：列表刷新后原下标越界要落回最近一条', () => {
    assert.equal(f.clampHistoryIndex(9, 3), 2)
    assert.equal(f.clampHistoryIndex(-2, 3), 0)
    assert.equal(f.clampHistoryIndex(undefined, 3), 0)
    assert.equal(f.clampHistoryIndex(1, 0), 0)
  })
})

describe('db-sql-history-panel: 预览文本', () => {
  const f = loadFns()

  test('保留内部换行与缩进（预览就是要原样）', () => {
    assert.equal(f.previewText('SELECT *\n  FROM t'), 'SELECT *\n  FROM t')
  })

  test('CRLF 收成 LF（Windows 剪贴板写进来的语句）', () => {
    assert.equal(f.previewText('a\r\nb\rc'), 'a\nb\nc')
  })

  test('去尾部空白，不动行首缩进', () => {
    assert.equal(f.previewText('  SELECT 1\n\n'), '  SELECT 1')
  })

  test('非字符串返回空串（历史文件被手改坏）', () => {
    assert.equal(f.previewText(null), '')
    assert.equal(f.previewText(123), '')
  })
})

describe('db-sql-history-panel: 筛选', () => {
  const f = loadFns()
  const LIST = [
    { sql: 'SELECT * FROM tgfsom_hsm_load_task' },
    { sql: 'select id from users where name = 1' },
    { sql: 'DROP TABLE x' }
  ]

  test('大小写不敏感的子串匹配', () => {
    assert.equal(f.filterHistory(LIST, 'TGFSOM').length, 1)
    assert.equal(f.filterHistory(LIST, 'select').length, 2)
  })

  test('只匹配语句，不匹配其它字段（库名命中不该冒出来）', () => {
    const withDb = [{ sql: 'SELECT 1', dbName: 'tgfsom_hsm' }]
    assert.equal(f.filterHistory(withDb, 'tgfsom_hsm').length, 0)
  })

  test('空关键字原样返回（不复制，引用可比）', () => {
    assert.equal(f.filterHistory(LIST, '   '), LIST)
  })

  test('无匹配返回空数组；非数组输入兜底为空', () => {
    assert.equal(f.filterHistory(LIST, 'zzz').length, 0)
    assert.equal(f.filterHistory(null, 'x').length, 0)
  })

  test('sql 字段缺失/非字符串不抛错', () => {
    assert.equal(f.filterHistory([{}, { sql: null }], 'x').length, 0)
  })
})
