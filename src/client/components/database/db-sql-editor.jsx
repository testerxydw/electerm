/**
 * SQL 编辑器外壳（阶段4 A-1 / A-3，设计 §4.2 / §4.6 / §4.7）
 *
 * 职责边界：
 * - 外壳：CM6 装配、方言高亮、主题跟随、只读、快捷键转发、页内查找适配
 * - 补全接线：只做 CM6 那一侧的适配（source、keymap、score 排序交给引擎），
 *   补全逻辑本身在 common/db-sql-complete.js，纯函数零依赖
 *
 * 三条实现纪律：
 * 1. 本文件是**唯一** import `@codemirror/*` 的地方 —— db-session 用 React.lazy 引入，
 *    CM6 因此只进异步 chunk（主 chunk 有构建断言兜底，见 check-cm6-chunk.js）
 * 2. 主题全部用 CSS 变量（`var(--text)` 等），不读一次 getComputedStyle：
 *    主题切换时 ui-theme.jsx 改写 :root 变量，变量在绘制时求值 → 编辑器自动跟随，
 *    无需监听主题变化，也无需重建 EditorView
 * 3. 方言从 sql-dialects.js 取，用 Compartment 挂载：切连接只 reconfigure 语言，
 *    不重建编辑器（保住历史、光标与滚动位置）
 */

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef
} from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab
} from '@codemirror/commands'
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap
} from '@codemirror/language'
import {
  autocompletion,
  startCompletion
} from '@codemirror/autocomplete'
import { sql, SQLDialect } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'
import { getDialect, cmDialectSpec } from '../../common/sql-dialects'
import { classifyContext, buildCompletions } from '../../common/db-sql-complete'
import { normalizeSqlEditorOpts } from '../../common/db-sql-opts'
import { scanTextHits } from './db-search'

// 4 行 ≈ 96px、12 行 ≈ 260px：与替换前的 Input.TextArea autoSize={minRows:4,maxRows:12} 对齐
const MIN_HEIGHT = 96
const MAX_HEIGHT = 260

const e = window.translate

/**
 * A-8 六项开关 → CM6 扩展（关掉的项返回空数组，不是"传 false 参数"——
 * 这些扩展没有开关参数，只能装/不装）
 */
function buildViewOptions (o) {
  const ext = []
  if (o.lineNumbers) {
    ext.push(lineNumbers(), highlightActiveLineGutter())
  }
  if (o.activeLine) {
    ext.push(highlightActiveLine())
  }
  if (o.lineWrap) {
    ext.push(EditorView.lineWrapping)
  }
  if (o.bracketMatch) {
    ext.push(bracketMatching())
  }
  if (o.fold) {
    ext.push(codeFolding(), foldGutter())
  }
  return ext
}

// SQLDialect 实例按方言 id 缓存：define 有解析开销，切 tab 不该重复付
const dialectCache = {}

function cmDialect (dbType) {
  const d = getDialect(dbType)
  if (!d) {
    return null
  }
  if (!dialectCache[d.id]) {
    // cmDialectSpec 负责把大写词表转小写（lang-sql 查表用小写 key，不做这个
    // 转换的话关键字一个都高亮不出来），方言细节仍只有 sql-dialects.js 一份
    dialectCache[d.id] = SQLDialect.define(cmDialectSpec(d))
  }
  return dialectCache[d.id]
}

// 页内查找的命中算法与 textarea 分支同源（db-search.scanTextHits），
// 只是这里的输入是 CM6 的全文——DOM 里只有可视行，不能靠 DOM 统计

// 候选上限：引擎裁剪与 CM6 渲染上限必须一致，否则"引擎给 200、只渲染 50"
// 看起来像丢候选
const MAX_OPTIONS = 50

/**
 * CM6 补全 source（设计 §4.6 接线六条）。
 * 每次都从 cfgRef 读最新配置：大小写/元数据变化不需要 reconfigure 编辑器。
 */
function createCompletionSource (cfgRef) {
  return (context) => {
    const cfg = cfgRef.current || {}
    if (!context.view) {
      return null
    }
    const text = context.state.doc.toString()
    const ctx = classifyContext(text, context.pos, { dialect: cfg.dialect })
    if (!ctx || ctx.kind === 'literal') {
      return null
    }
    // 空前缀（如刚打完 `FROM `）只在显式触发时弹，否则每敲一个空格就蹦菜单
    if (!context.explicit && !ctx.prefix) {
      return null
    }
    const res = buildCompletions(ctx, {
      dialect: cfg.dialect,
      keywordCase: cfg.keywordCase,
      tables: cfg.tables || [],
      columns: cfg.columns || {},
      max: MAX_OPTIONS
    })
    if (!res || !res.options.length) {
      return null
    }
    const pureWord = !!(ctx.token && !ctx.token.quoted && !ctx.qualifier.length)
    return {
      from: res.from,
      options: res.options,
      // §4.6 第 5 条：只有纯标识符前缀才给 validFor。
      // 带引号或限定链时结果随光标漂移，复用旧结果会给出错位候选
      validFor: pureWord ? /^[\w$]*$/ : undefined
    }
  }
}

// 高亮配色：全部指向 CSS 变量，浅/深主题靠变量切换，不留第二份色板
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--primary)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--info)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-dark)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.typeName)], color: 'var(--warn)' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: 'var(--text-light)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--text)' },
  { tag: [tags.operator, tags.punctuation, tags.paren, tags.bracket], color: 'var(--text-dark)' },
  { tag: tags.invalid, color: 'var(--error)' }
])

// 外壳主题。这里每个颜色都必须是 var(--x)，否则主题切换会残留旧色
const shellTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontSize: '12px',
    border: '1px solid var(--main-light)',
    borderRadius: 'var(--radius-xs)',
    minHeight: MIN_HEIGHT + 'px',
    maxHeight: MAX_HEIGHT + 'px'
  },
  '&.cm-focused': {
    outline: 'none',
    borderColor: 'var(--primary)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--db-code-font, var(--font-mono))',
    lineHeight: '1.5',
    maxHeight: (MAX_HEIGHT - 2) + 'px',
    overflow: 'auto'
  },
  '.cm-content': {
    caretColor: 'var(--primary)',
    padding: '4px 0'
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--primary)'
  },
  // 半透明选中：color-mix 让 --primary 跟着主题走
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 30%, transparent)'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-dark)',
    border: 'none',
    borderRight: '1px solid var(--main-light)',
    paddingRight: '4px'
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 8%, transparent)'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text)'
  },
  '.cm-placeholder': {
    color: 'var(--text-disabled)'
  },
  // 补全浮层：CM6 自带 baseTheme 是固定的浅色，必须整套改写成 token，
  // 否则深色主题下会弹出一块白底菜单
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: 'var(--shadow-2)'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    maxHeight: '230px'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '3px 8px',
    lineHeight: '1.4',
    color: 'var(--text)'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--hover-bg)',
    color: 'var(--text)'
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    color: 'var(--primary)',
    fontWeight: '600'
  },
  '.cm-completionDetail': {
    color: 'var(--text-dark)',
    fontStyle: 'normal',
    marginLeft: '8px'
  },
  '.cm-completionIcon': {
    opacity: '0.7',
    paddingRight: '4px'
  }
})

const SqlCodeEditor = forwardRef(function SqlCodeEditor (props, ref) {
  const {
    value = '',
    onChange,
    onRun,
    onFormat,
    readOnly = false,
    dbType,
    placeholder = '',
    // A-7：补全关键字/函数/类型的大小写，'lower' | 'upper'
    keywordCase = 'lower',
    // A-4 / A-5 的数据来源（本轮为空，接元数据后由父组件喂）
    tables = [],
    columns = {},
    // A-8：六项可选能力，只传改了的那几项也行（内部按默认值补齐）
    opts = null,
    className = '',
    // D 批：编辑器选区右键「解释所选」回调（无选区走浏览器默认菜单）
    onExplainSelection = null
  } = props

  const hostRef = useRef(null)
  const viewRef = useRef(null)
  // 回调放 ref：EditorView 只创建一次，扩展里读到的必须是"最新"回调，
  // 否则父组件重渲染后 Ctrl+Enter 会调到上一轮闭包（旧 sqlText）
  const cbRef = useRef({ onChange, onRun, onFormat, onExplainSelection })
  cbRef.current = { onChange, onRun, onFormat, onExplainSelection }

  // 补全配置同理：source 在 view 生命周期里只注册一次，配置必须走 ref
  const cfgRef = useRef({})
  cfgRef.current = {
    dialect: getDialect(dbType),
    keywordCase,
    tables,
    columns
  }

  const searchKwRef = useRef('')
  const langCompartment = useRef(new Compartment())
  const roCompartment = useRef(new Compartment())
  const phCompartment = useRef(new Compartment())
  // A-8：六项外壳能力共用一个 compartment —— 任一项变化都整块 reconfig，
  // 拆成六个反而要六次 dispatch，且它们之间没有独立重配的必要
  const optCompartment = useRef(new Compartment())
  // 自动补全单独一个：关掉时要真的卸掉扩展（含 Ctrl-Space 的 startCompletion），
  // 和"外壳"那五项不是一类
  const compCompartment = useRef(new Compartment())

  useImperativeHandle(ref, () => ({
    focus () {
      const view = viewRef.current
      if (view) {
        view.focus()
      }
    },
    getValue () {
      const view = viewRef.current
      return view ? view.state.doc.toString() : ''
    },
    // 当前选区文本（无选区返回空串）：D 批「解释」入口优先解释选区
    getSelectionText () {
      const view = viewRef.current
      if (!view) {
        return ''
      }
      const s = view.state.selection.main
      return s.from === s.to ? '' : view.state.doc.sliceString(s.from, s.to)
    },
    // 光标处插入（B-1 收藏"插入光标"/B-3 模板菜单共用）：
    // 有选区则替换选区，无选区在光标处插入；插入后光标落在文本尾部。
    // 走 dispatch 而不是 onChange 回写全文——保留撤销栈，且不丢光标位置
    insertText (text) {
      const view = viewRef.current
      if (!view || typeof text !== 'string') {
        return false
      }
      const sel = view.state.selection.main
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        scrollIntoView: true
      })
      view.focus()
      return true
    },
    // 页内查找：返回全文命中区间
    getSearchHits (kw) {
      const view = viewRef.current
      return view ? scanTextHits(view.state.doc.toString(), kw) : []
    },
    // 记录当前查找词，供 selectSearchHit 使用（导航只给序号）
    setSearchKeyword (kw) {
      searchKwRef.current = kw
    },
    // 定位第 index 个命中：滚动进视口并选中（选区即"当前命中"高亮）
    selectSearchHit (index) {
      const view = viewRef.current
      if (!view) {
        return
      }
      const hit = scanTextHits(view.state.doc.toString(), searchKwRef.current)[index]
      if (!hit) {
        return
      }
      view.focus()
      view.dispatch({
        selection: { anchor: hit.start, head: hit.end },
        effects: EditorView.scrollIntoView(hit.start, { y: 'nearest' })
      })
    }
  }))

  // 建 view：只在挂载时执行一次
  useEffect(() => {
    const d = cmDialect(dbType)
    const o = normalizeSqlEditorOpts(opts)
    const state = EditorState.create({
      doc: value,
      extensions: [
        optCompartment.current.of(buildViewOptions(o)),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        // 方言放 Compartment：切连接只换语言，不重建 view
        langCompartment.current.of(d ? sql({ dialect: d }) : []),
        syntaxHighlighting(highlightStyle),
        shellTheme,
        phCompartment.current.of(cmPlaceholder(placeholder)),
        // 补全：用 override 装自己的 source，不用默认 completeFromList
        // （默认那个只管单词列表，拿不到场景判定与元数据）
        compCompartment.current.of(
          o.autoComplete
            ? autocompletion({
              override: [createCompletionSource(cfgRef)],
              activateOnTyping: true,
              maxRenderedOptions: MAX_OPTIONS
            })
            : []
        ),
        roCompartment.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly)
        ]),
        keymap.of([
          // 与替换前 textarea 的 onKeyDown 同键位：Mod-Enter 执行 / Mod-Shift-F 格式化
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              cbRef.current.onRun && cbRef.current.onRun()
              return true
            }
          },
          {
            key: 'Mod-Shift-f',
            preventDefault: true,
            run: () => {
              cbRef.current.onFormat && cbRef.current.onFormat()
              return true
            }
          },
          // A-2 余项：手动触发补全（mac 上 Cmd-Space 被 Spotlight 占用，
          // CM6 自带的 Alt-` / Alt-i 仍然可用）
          {
            key: 'Mod-Space',
            preventDefault: true,
            run: startCompletion
          },
          ...defaultKeymap,
          ...historyKeymap,
          // 折叠键位常驻：扩展关着时这些命令是空操作，不会抢键；
          // 放进条件分支反而会让"运行中打开折叠"没有快捷键可用
          ...foldKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && cbRef.current.onChange) {
            cbRef.current.onChange(update.state.doc.toString())
          }
        }),
        // 页内查找的 DOM 分支靠它认出"这段文本在编辑器里"，不参与命中计数
        EditorView.contentAttributes.of({ 'data-db-sql-editor': '1' })
      ]
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 故意只在挂载时建 view：其余属性都走 reconfigure
  }, [])

  // 外部改值（SQL 历史回填 / 格式化 / 清空）：doc 与 value 不一致才 dispatch，
  // 避免"输入 → onChange → 父组件回灌 → 覆盖光标"的循环
  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    const cur = view.state.doc.toString()
    if (value !== cur) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
        // 外部替换后光标落到文末，与历史回填的直觉一致
        selection: { anchor: value.length }
      })
    }
  }, [value])

  // 切库/切引擎（同 tab 内重连）：只换方言
  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    const d = cmDialect(dbType)
    view.dispatch({
      effects: langCompartment.current.reconfigure(d ? sql({ dialect: d }) : [])
    })
  }, [dbType])

  // 只读开关：reconfigure 而不是重建，保住选区与滚动
  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    view.dispatch({
      effects: roCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly)
      ])
    })
  }, [readOnly])

  // 语言切换（locale）会换 placeholder 文案
  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    view.dispatch({
      effects: phCompartment.current.reconfigure(cmPlaceholder(placeholder))
    })
  }, [placeholder])

  // D 批：选区右键「解释所选」。有非空选区时阻止默认菜单、弹自绘单项菜单；
  // 无选区（或未接回调）走浏览器默认菜单。菜单坐标存 state，关闭即消失
  const [ctxMenu, setCtxMenu] = useState(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return undefined
    }
    const onCtx = ev => {
      const view = viewRef.current
      if (!view || !cbRef.current.onExplainSelection) {
        return
      }
      const s = view.state.selection.main
      if (s.from === s.to) {
        return
      }
      ev.preventDefault()
      setCtxMenu({ x: ev.clientX, y: ev.clientY })
    }
    host.addEventListener('contextmenu', onCtx)
    return () => host.removeEventListener('contextmenu', onCtx)
  }, [])

  // A-8：六项开关变化 → 整块 reconfig，不重建 view（保住文本、光标、滚动与撤销栈）
  const optSig = JSON.stringify(normalizeSqlEditorOpts(opts))
  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }
    const o = normalizeSqlEditorOpts(opts)
    view.dispatch({
      effects: [
        optCompartment.current.reconfigure(buildViewOptions(o)),
        compCompartment.current.reconfigure(
          o.autoComplete
            ? autocompletion({
              override: [createCompletionSource(cfgRef)],
              activateOnTyping: true,
              maxRenderedOptions: MAX_OPTIONS
            })
            : []
        )
      ]
    })
    // 依赖用签名而不是 opts 对象：父组件每次渲染都可能给新对象，
    // 直接依赖对象会把"值没变"也当成变化，每个渲染周期都 dispatch 一次
  }, [optSig])

  return (
    <>
      <div
        ref={hostRef}
        className={'db-sql-editor' + (readOnly ? ' db-sql-editor-readonly' : '') + (className ? ' ' + className : '')}
      />
      {
        ctxMenu
          ? (
            <div
              className='db-sql-ctx-overlay'
              onMouseDown={() => setCtxMenu(null)}
              onContextMenu={ev => {
                ev.preventDefault()
                setCtxMenu(null)
              }}
            >
              <div className='db-sql-ctx-menu' style={{ left: ctxMenu.x, top: ctxMenu.y }}>
                <div
                  className='db-sql-ctx-item'
                  onMouseDown={ev => {
                    ev.stopPropagation()
                    setCtxMenu(null)
                    if (cbRef.current.onExplainSelection) {
                      cbRef.current.onExplainSelection()
                    }
                  }}
                >
                  {e('dbExplainSelection')}
                </div>
              </div>
            </div>
            )
          : null
      }
    </>
  )
})

export default SqlCodeEditor
