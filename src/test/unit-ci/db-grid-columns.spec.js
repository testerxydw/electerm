// H1a-4 · 公共列工厂 buildGridColumns 的行为单测（纯函数直测）
//
// 背景：db51b26b 把数据页 / SQL 结果页两处列定义收进 db-grid-columns.jsx 的
// buildGridColumns。工厂是纯函数（options → antd columns 数组），适合直接执行
// 断言；但源文件是 JSX，Node 不能直接跑 —— 这里用仓库 devDependency 里现成的
// @babel/core 写一个 ~40 行的 JSX→createElement 迷你插件做转译，再在 vm 里用
// 桩（React.createElement / antd.Input / ColHead）执行**同一份源码**，
// 不出现"测试拷贝实现"。common 纯函数（wideColumnWidth / cellAlignClass）
// 用同一 strip-export 手法装真件，与 db-column-width.spec.js 同风格。
//
// 覆盖点：基本形态 / 可见性过滤 / 类型与注释 / 复合宽键 / 排序互斥 /
// 单元格交互 / 键盘可达 / 编辑态 render 分支。
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const babel = require('@babel/core')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/components/database/db-grid-columns.jsx')
const COMMON_DIR = path.join(ROOT, 'src/client/common')

// ---- JSX → React.createElement 迷你转译（仅覆盖工厂用到的 JSX 形态：
//      自闭合/嵌套元素、字符串与表达式属性、无 spread、无 fragment）----
const jsxPlugin = ({ types: t }) => {
  const tagNameOf = (name) => {
    if (t.isJSXIdentifier(name)) return t.identifier(name.name)
    if (t.isJSXMemberExpression(name)) {
      return t.memberExpression(tagNameOf(name.object), t.identifier(name.property.name))
    }
    throw new Error('unsupported JSX name: ' + name.type)
  }
  const propsOf = (opening) => {
    const pairs = opening.attributes.map(attr => {
      if (t.isJSXAttribute(attr)) {
        const key = t.isJSXNamespacedName(attr.name)
          ? t.stringLiteral(attr.name.namespace.name + ':' + attr.name.name.name)
          : t.identifier(attr.name.name)
        const val = attr.value == null
          ? t.booleanLiteral(true)
          : t.isJSXExpressionContainer(attr.value)
            ? attr.value.expression
            : attr.value
        return t.objectProperty(key, val)
      }
      return t.spreadElement(attr.argument) // JSXSpreadAttribute
    })
    return pairs.some(p => t.isSpreadElement(p))
      ? t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), [t.objectExpression([]), ...pairs])
      : t.objectExpression(pairs)
  }
  return {
    visitor: {
      JSXFragment: { exit (p) { p.replaceWith(t.callExpression(t.identifier('React.createElement'), [t.identifier('React.Fragment'), t.objectExpression([]), ...p.node.children])) } },
      JSXElement: {
        exit (p) {
          const kids = p.node.children.map(c => t.isJSXText(c) ? t.stringLiteral(c.value) : c)
          p.replaceWith(t.callExpression(t.identifier('React.createElement'), [
            tagNameOf(p.node.openingElement.name), propsOf(p.node.openingElement), ...kids
          ]))
        }
      }
    }
  }
}

// common 纯函数真件加载（strip export + vm，同 db-column-width.spec.js 的 loadMod）
const loadCommon = (file) => {
  const src = fs.readFileSync(path.join(COMMON_DIR, file), 'utf8')
  const names = [...src.matchAll(/^export (?:function|const|class|let) (\w+)/gm)].map(m => m[1])
  const code = src.replace(/^export /gm, '') + '\n;module.exports = {' + names.join(',') + '}'
  const sandbox = { console, module: { exports: {} }, Math, String, Number, Boolean, JSON, Object, Array, Set, Map, Date, Intl, RegExp, Error, TypeError, isNaN, parseInt, parseFloat, Symbol }
  vm.runInNewContext(code, sandbox, { filename: file })
  return sandbox.module.exports
}

const colWidthMod = loadCommon('db-column-width.js')
const fmtValueMod = loadCommon('db-format-value.js')

// ---- React / antd / ColHead 桩 ----
const createElement = (type, props, ...kids) => ({
  $$jsx: true,
  type: typeof type === 'function' ? type.name : String(type),
  props,
  kids
})
const React = { createElement }
function StubColHead () {}
function StubInput () {}
const antd = { Input: StubInput }

let buildGridColumns
let CELL_ELLIPSIS

before(async () => {
  const src = fs.readFileSync(MOD, 'utf8')
  const { code } = babel.transformSync(src, {
    plugins: [jsxPlugin],
    parserOpts: { plugins: ['jsx'] },
    babelrc: false,
    configFile: false
  })
  const js = code
    .replace(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/gm,
      (m, named, def, p) => named
        ? `const { ${named.trim()} } = __require(${JSON.stringify(p)})`
        : `const ${def} = __require(${JSON.stringify(p)})`)
    .replace(/^export /gm, '')
  const sandboxRequire = (p) => {
    if (p === 'react') return React
    if (p === 'antd') return antd
    if (p === './db-col-resize') return { ColHead: StubColHead }
    if (p === '../../common/db-column-width') return colWidthMod
    if (p === '../../common/db-format-value') return fmtValueMod
    throw new Error('unexpected require: ' + p)
  }
  const sandbox = {
    React,
    antd,
    __require: sandboxRequire,
    console,
    module: { exports: {} }
  }
  vm.runInNewContext(js + '\n;module.exports = { buildGridColumns, CELL_ELLIPSIS }', sandbox, { filename: 'db-grid-columns.jsx' })
  buildGridColumns = sandbox.module.exports.buildGridColumns
  CELL_ELLIPSIS = sandbox.module.exports.CELL_ELLIPSIS
})

// ---- 固件 ----
const makeWg = (map = {}) => ({ widthOf: k => (map[k] == null ? 111 : map[k]), hasManual: false })
const makeColMenu = () => {
  const seen = []
  return { openColMenu: (ev, arg) => seen.push(arg), seen }
}
const makeRender = () => {
  const calls = []
  const fn = (v, kw, dt) => { calls.push({ v, kw, dt }); return { $$cell: v } }
  fn.calls = calls
  return fn
}
const row = (key, vals) => ({ __rowKey: key, ...vals })

describe('buildGridColumns 基本形态与可见性过滤', () => {
  test('正常路径：列名进 dataIndex/key，宽度走三源 widthOf，表头是 ColHead 元素', () => {
    const wg = makeWg({ id: 120 })
    const cols = buildGridColumns({
      keys: ['id', 'name'],
      wg,
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    })
    assert.equal(cols.length, 2)
    assert.deepEqual(cols.map(c => c.dataIndex), ['id', 'name'])
    assert.deepEqual(cols.map(c => c.key), ['id', 'name'])
    assert.equal(cols[0].width, 120, 'width 必须来自 wg.widthOf')
    assert.equal(cols[1].width, 111, '未配宽的列走 wg.widthOf 的兜底')
    // 截断配置：rc-table 原生 title 必须显式关掉（跨 realm 对象走属性断言）
    assert.equal(CELL_ELLIPSIS.showTitle, false)
    assert.deepEqual(Object.keys(CELL_ELLIPSIS), ['showTitle'])
    assert.equal(cols[0].ellipsis, CELL_ELLIPSIS, 'ellipsis 必须引用共享的 CELL_ELLIPSIS')
    // 表头是 ColHead 桩元素，label 是列名本身
    const title = cols[0].title
    assert.ok(title.$$jsx, 'title 必须是 React 元素')
    assert.equal(title.type, 'StubColHead')
    assert.equal(title.props.label, 'id')
  })

  test('空键 / 全隐藏 → 空数组；isVisible 谓词过滤且保持列序', () => {
    const base = { wg: makeWg(), colMenu: makeColMenu(), selectCell: () => {}, renderCell: makeRender() }
    assert.deepEqual(buildGridColumns({ ...base, keys: [] }), [])
    const allHidden = buildGridColumns({ ...base, keys: ['a', 'b'], isVisible: () => false })
    assert.deepEqual(allHidden, [], '全部隐藏必须得到空列，不能炸')
    const partial = buildGridColumns({
      ...base,
      keys: ['c1', 'b', 'c2'],
      isVisible: k => !k.startsWith('c')
    })
    assert.deepEqual(partial.map(c => c.dataIndex), ['b'], '过滤后必须保持原列序')
  })
})

describe('类型映射 / 注释 / 数值右对齐', () => {
  test('无 typeMap：dataType 按空串处理，renderCell 收到空类型', () => {
    const r = makeRender()
    const cols = buildGridColumns({
      keys: ['id'],
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: r
    })
    cols[0].render('v1', row('r1', {}))
    assert.equal(r.calls[0].dt, '', '查不到类型必须给空串，不能给 undefined')
    assert.equal(r.calls[0].kw, '', 'filterKw 缺省是空串')
  })

  test('typeMap 小写匹配大小写不敏感；数值列对齐 class 按类型给一次', () => {
    const r = makeRender()
    const cols = buildGridColumns({
      keys: ['Name', 'Id'],
      typeMap: { name: 'varchar', id: 'int' },
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: r
    })
    cols[0].render('x', row('r1', {}))
    assert.equal(r.calls[0].dt, 'varchar', "'Name' 必须命中小写键 name")
    const numCls = cols[1].onCell(row('r1', {})).className
    assert.equal(numCls, 'db-cell-num', "int 列按 cellAlignClass 给 'db-cell-num'")
    const plainCls = cols[0].onCell(row('r1', {})).className
    assert.equal(plainCls, '', 'varchar 列不右对齐')
  })

  test('showComment：注释按小写键进 ColHead；关掉时 comment 为 undefined', () => {
    const mk = (show) => buildGridColumns({
      keys: ['id'],
      commentMap: { id: '主键' },
      showComment: show,
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    })[0].title
    assert.equal(mk(true).props.comment, '主键')
    assert.equal(mk(false).props.comment, undefined, 'showComment=false 不该把注释漏给表头')
    // commentMap 缺省 null 不得抛
    assert.doesNotThrow(() => buildGridColumns({
      keys: ['id'],
      showComment: true,
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    }))
  })
})

describe('SQL 复合宽键（下标::列名）与表头菜单标题', () => {
  test('widthKeyOf 只影响宽度与列菜单键，dataIndex/key 恒为列名', () => {
    const wg = makeWg({ '0::id': 222 })
    const cm = makeColMenu()
    const cols = buildGridColumns({
      keys: ['id'],
      wg,
      colMenu: cm,
      wideRows: [{ id: 'x' }],
      widthKeyOf: k => '0::' + k,
      headKeyOf: k => k,
      selectCell: () => {},
      renderCell: makeRender()
    })
    assert.equal(cols[0].width, 222, '宽度必须按复合键取')
    assert.equal(cols[0].dataIndex, 'id', 'dataIndex 不能带前缀')
    assert.equal(cols[0].key, 'id')
    const headerProps = cols[0].onHeaderCell()
    assert.equal(typeof headerProps.onContextMenu, 'function', '右键列宽菜单必须挂在 onHeaderCell 上')
    headerProps.onContextMenu({})
    assert.equal(cm.seen.length, 1)
    assert.equal(cm.seen[0].key, '0::id', '列菜单收到的键是复合键')
    assert.equal(cm.seen[0].head, 'id', 'headKeyOf 决定菜单标题，不露复合键')
    assert.equal(cm.seen[0].wide, colWidthMod.wideColumnWidth([{ id: 'x' }], 'id'),
      '菜单上的 wide 必须现场量（与 wideColumnWidth 同源）')
  })

  test('widthKeyOf 缺省：宽度键就是列名，菜单参数不带 head', () => {
    const wg = makeWg({ id: 90 })
    const cm = makeColMenu()
    const cols = buildGridColumns({
      keys: ['id'],
      wg,
      colMenu: cm,
      wideRows: [],
      selectCell: () => {},
      renderCell: makeRender()
    })
    assert.equal(cols[0].width, 90)
    cols[0].onHeaderCell().onContextMenu({})
    assert.equal(cm.seen[0].key, 'id')
    assert.ok(!('head' in cm.seen[0]), 'headKeyOf 缺省时菜单参数不得带 head 字段')
  })
})

describe('排序：serverSort / clientSort 互斥能力', () => {
  test('serverSort：col.sorter=true + sortOrder 来自 sortOrderOf，ColHead 不接排序', () => {
    const cols = buildGridColumns({
      keys: ['a'],
      wg: makeWg(),
      colMenu: makeColMenu(),
      serverSort: true,
      sortOrderOf: k => k === 'a' ? 'ascend' : null,
      selectCell: () => {},
      renderCell: makeRender()
    })
    assert.equal(cols[0].sorter, true)
    assert.equal(cols[0].sortOrder, 'ascend')
    assert.equal(cols[0].title.props.sort, null, '服务端排序不接 ColHead 受控箭头')
    assert.equal(cols[0].title.props.onSort, undefined)
  })

  test('clientSort：col 无 sorter，ColHead 接受控 sort + onSort 回调', () => {
    const seen = []
    const cols = buildGridColumns({
      keys: ['a', 'b'],
      wg: makeWg(),
      colMenu: makeColMenu(),
      clientSort: true,
      sortOf: k => k === 'a' ? 'descend' : null,
      onSort: k => seen.push(k),
      selectCell: () => {},
      renderCell: makeRender()
    })
    assert.ok(!('sorter' in cols[0]), '客户端排序不得给 antd 的 sorter 标记')
    assert.equal(cols[0].title.props.sort, 'descend')
    assert.equal(typeof cols[0].title.props.onSort, 'function')
    cols[0].title.props.onSort()
    assert.deepEqual(seen, ['a'], 'onSort 必须带上列名')
    assert.equal(cols[1].title.props.sort, null, '未排序列受控值为 null（ColHead 不画箭头）')
    // 工厂把 onSort 挂到 clientSort 开着的每一列（箭头显隐由受控 sort 决定），
    // 这里钉住的是"受控值为 null"而不是"没有 onSort"
    assert.equal(typeof cols[1].title.props.onSort, 'function')
  })

  test('两个开关全关（SQL 之外的网格形态）：无 sorter，ColHead sort 为 null', () => {
    const cols = buildGridColumns({
      keys: ['a'],
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    })
    assert.ok(!('sorter' in cols[0]))
    assert.ok(!('sortOrder' in cols[0]))
    assert.equal(cols[0].title.props.sort, null)
  })
})

describe('单元格交互（onCell）：选中 / 右键菜单 / 双击编辑', () => {
  test('单击选中：onClick 带 (row, k)；selectedOf 命中时高亮 class；class 组合顺序与原实现一致', () => {
    const picked = []
    const r = row('r1', { a: 1 })
    const cols = buildGridColumns({
      keys: ['a'],
      typeMap: { a: 'int' },
      cellBaseClass: 'db-cell-editable',
      selectedOf: (rw, k) => rw === r && k === 'a',
      selectCell: (rw, k) => picked.push([rw, k]),
      wg: makeWg(),
      colMenu: makeColMenu(),
      renderCell: makeRender()
    })
    const cell = cols[0].onCell(r)
    cell.onClick()
    assert.deepEqual(picked, [[r, 'a']])
    // 数据页顺序：base 在前、numCls 次之、selected 最后（与原实现逐字一致）
    assert.equal(cell.className, 'db-cell-editable db-cell-num db-cell-selected')
    // 未选中时高亮 class 不出现
    const cols2 = buildGridColumns({
      keys: ['a'],
      selectCell: () => {},
      wg: makeWg(),
      colMenu: makeColMenu(),
      renderCell: makeRender()
    })
    assert.equal(cols2[0].onCell(r).className, '')
  })

  test('cellMenu：开时 onContextMenu 调 openCellMenu(ev, row, k)；关时不挂', () => {
    const seen = []
    const ev = {}
    const r = row('r1', { a: 1 })
    const on = buildGridColumns({
      keys: ['a'],
      cellMenu: true,
      openCellMenu: (e, rw, k) => seen.push([e, rw, k]),
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    })[0].onCell(r)
    on.onContextMenu(ev)
    assert.deepEqual(seen, [[ev, r, 'a']])
    const off = buildGridColumns({
      keys: ['a'],
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    })[0].onCell(r)
    assert.ok(!('onContextMenu' in off), '关掉 cellMenu 不得挂右键')
  })

  test('editable：双击进编辑受 canEditCell 闸门；只读态双击无效', () => {
    const starts = []
    const r = row('r1', { a: 1 })
    const mk = (canEdit) => buildGridColumns({
      keys: ['a'],
      editable: true,
      canEditCell: canEdit,
      startEdit: (rw, k) => starts.push([rw, k]),
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    })[0].onCell(r)
    mk(true).onDoubleClick()
    assert.deepEqual(starts, [[r, 'a']], '可编辑表双击必须进编辑')
    mk(false).onDoubleClick()
    assert.equal(starts.length, 1, '只读表双击不得进编辑')
    // editable 关（SQL 只读）：连 onDoubleClick 都不挂
    const ro = buildGridColumns({
      keys: ['a'],
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: makeRender()
    })[0].onCell(r)
    assert.ok(!('onDoubleClick' in ro))
    assert.ok(!('tabIndex' in ro), '只读网格不做键盘可达')
  })
})

describe('键盘可达（keyboardAccessible）', () => {
  const fire = (cell, key) => {
    const log = []
    const sentinel = { td: true }
    cell.onKeyDown({
      key,
      target: sentinel,
      currentTarget: sentinel, // 相等 = 事件来自 td 自身而非编辑框冒泡
      preventDefault: () => log.push('pd')
    })
    return log
  }
  const mkCols = (canEdit) => {
    const log = { select: [], edit: [], clear: 0 }
    const cols = buildGridColumns({
      keys: ['a'],
      keyboardAccessible: true,
      canEditCell: canEdit,
      selectCell: () => log.select.push(1),
      startEdit: () => log.edit.push(1),
      onClearSelection: () => { log.clear++ },
      wg: makeWg(),
      colMenu: makeColMenu(),
      renderCell: makeRender()
    })
    return { cell: cols[0].onCell(row('r1', { a: 1 })), log }
  }

  test('td 上挂 tabIndex/aria-label；Enter 预览并在可编辑时直接进编辑', () => {
    const { cell, log } = mkCols(true)
    assert.equal(cell.tabIndex, 0)
    assert.equal(cell['aria-label'], 'a')
    fire(cell, 'Enter')
    assert.equal(log.select.length, 1)
    assert.equal(log.edit.length, 1, 'canEditCell 时 Enter 预览后直接编辑')
    assert.deepEqual(fire(cell, 'Enter'), ['pd'], 'Enter 必须阻止默认')
  })

  test('只读表 Enter 只预览不编辑；F2 只在可编辑时生效；Escape 走 onClearSelection', () => {
    const ro = mkCols(false)
    fire(ro.cell, 'Enter')
    assert.equal(ro.log.select.length, 1)
    assert.equal(ro.log.edit.length, 0, '只读表 Enter 不得进编辑')
    fire(ro.cell, 'F2')
    assert.equal(ro.log.edit.length, 0, '只读表 F2 不得进编辑')
    const rw = mkCols(true)
    fire(rw.cell, 'F2')
    assert.equal(rw.log.edit.length, 1, '可编辑表 F2 直接编辑')
    fire(rw.cell, 'F2')
    assert.deepEqual(fire(rw.cell, 'F2'), ['pd'])
    fire(rw.cell, 'Escape')
    assert.equal(rw.log.clear, 1, 'Escape 必须清选中/编辑')
    // 编辑框内冒泡（target !== currentTarget）必须直接忽略
    const before = rw.log.select.length
    const sentinel = { td: true }
    rw.cell.onKeyDown({ key: 'Enter', target: {}, currentTarget: sentinel, preventDefault: () => {} })
    assert.equal(rw.log.select.length, before, '编辑框内按键不得重复触发 td 动作')
  })
})

describe('编辑态 render 分支（editable + editing）', () => {
  const base = {
    keys: ['a'],
    editable: true,
    canEditCell: true,
    wg: makeWg(),
    colMenu: makeColMenu(),
    selectCell: () => {},
    startEdit: () => {},
    cancelEdit: () => {},
    submitEdit: () => {},
    onEditValueChange: () => {}
  }
  const r1 = row('r1', { a: 1 })

  test('editing 命中 (rowKey, col)：render 换成编辑框 Input，值/回调全接线', () => {
    const log = { change: [], cancel: 0 }
    const col = buildGridColumns({
      ...base,
      editing: { rowKey: 'r1', col: 'a' },
      editValue: '草稿',
      onEditValueChange: v => log.change.push(v),
      cancelEdit: () => { log.cancel++ }
    })[0]
    const el = col.render('原值', r1)
    assert.ok(el.$$jsx, '编辑态必须是 React 元素')
    assert.equal(el.type, 'StubInput', '编辑框必须是 antd Input（桩名核对）')
    assert.equal(el.props.value, '草稿')
    assert.equal(el.props.autoFocus, true)
    el.props.onChange({ target: { value: '新值' } })
    assert.deepEqual(log.change, ['新值'], 'onChange 必须把输入值递给 onEditValueChange')
    assert.equal(typeof el.props.onPressEnter, 'function', 'Enter 提交必须接线')
    el.props.onKeyDown({ key: 'Escape', preventDefault: () => {} })
    assert.equal(log.cancel, 1, '编辑框内 Escape 必须退出编辑')
    el.props.onBlur()
    assert.equal(log.cancel, 2, '失焦退出编辑')
  })

  test('editing 不命中 / editing 为 null：render 走 renderCell(v, filterKw, dataType)', () => {
    const r = makeRender()
    const col = buildGridColumns({
      ...base,
      filterKw: 'kw1',
      typeMap: { a: 'int' },
      editing: { rowKey: 'r2', col: 'a' },
      renderCell: r
    })[0]
    col.render('x', r1)
    assert.equal(r.calls[0].v, 'x')
    assert.equal(r.calls[0].kw, 'kw1')
    assert.equal(r.calls[0].dt, 'int')
    // editing=null
    const col2 = buildGridColumns({ ...base, editing: null, renderCell: r })[0]
    col2.render('y', r1)
    assert.equal(r.calls[1].v, 'y')
  })

  test('editable=false 时 editing 即便传入也不生效（SQL 只读的兜底）', () => {
    const r = makeRender()
    const col = buildGridColumns({
      keys: ['a'],
      editing: { rowKey: 'r1', col: 'a' },
      editValue: '草稿',
      wg: makeWg(),
      colMenu: makeColMenu(),
      selectCell: () => {},
      renderCell: r
    })[0]
    const el = col.render('x', r1)
    assert.equal(r.calls[0].v, 'x', '未开 editable 不得渲染编辑框')
    assert.ok(!el.$$jsx, '只读 render 直接走 renderCell 的返回值')
  })
})
