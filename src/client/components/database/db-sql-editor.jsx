/**
 * SQL 编辑器外壳（阶段4 A-1，设计 §4.2 / §4.7）
 *
 * 职责边界：
 * - 只做「外壳」：CM6 装配、方言高亮、主题跟随、只读、快捷键转发、页内查找适配
 * - 不做补全（A-3 起在 completion source 里加，见 §4.6）
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
  syntaxHighlighting
} from '@codemirror/language'
import { sql, SQLDialect } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'
import { getDialect } from '../../common/sql-dialects'
import { scanTextHits } from './db-search'

// 4 行 ≈ 96px、12 行 ≈ 260px：与替换前的 Input.TextArea autoSize={minRows:4,maxRows:12} 对齐
const MIN_HEIGHT = 96
const MAX_HEIGHT = 260

// SQLDialect 实例按方言 id 缓存：define 有解析开销，切 tab 不该重复付
const dialectCache = {}

function cmDialect (dbType) {
  const d = getDialect(dbType)
  if (!d) {
    return null
  }
  if (!dialectCache[d.id]) {
    dialectCache[d.id] = SQLDialect.define({
      // CM6 要空格分隔的字符串；表里存数组是为了单测与去重
      keywords: d.keywords.join(' '),
      builtin: d.builtin.join(' '),
      types: d.types.join(' '),
      // 反引号 / 双引号：决定 `` `us `` 这类未闭合标识符能否被识别为标识符
      identifierQuotes: d.quote,
      // PG 的 # 不是注释；mysql 吞到行尾
      hashComments: d.hashComment,
      // mysql 字符串吃反斜杠转义，PG 不吃（'C:\path' 在 PG 里是普通字符串）
      backslashEscapes: d.backslashEscapes,
      // mysql 的 -- 必须后跟空白才是注释
      spaceAfterDashes: d.spaceAfterDashes,
      // $tag$...$tag$（PG 函数体）只有 PG 需要
      doubleDollarQuotedStrings: d.dollarQuote
    })
  }
  return dialectCache[d.id]
}

// 页内查找的命中算法与 textarea 分支同源（db-search.scanTextHits），
// 只是这里的输入是 CM6 的全文——DOM 里只有可视行，不能靠 DOM 统计

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
    className = ''
  } = props

  const hostRef = useRef(null)
  const viewRef = useRef(null)
  // 回调放 ref：EditorView 只创建一次，扩展里读到的必须是"最新"回调，
  // 否则父组件重渲染后 Ctrl+Enter 会调到上一轮闭包（旧 sqlText）
  const cbRef = useRef({ onChange, onRun, onFormat })
  cbRef.current = { onChange, onRun, onFormat }

  const searchKwRef = useRef('')
  const langCompartment = useRef(new Compartment())
  const roCompartment = useRef(new Compartment())
  const phCompartment = useRef(new Compartment())

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
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
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
          ...defaultKeymap,
          ...historyKeymap,
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

  return (
    <div
      ref={hostRef}
      className={'db-sql-editor' + (readOnly ? ' db-sql-editor-readonly' : '') + (className ? ' ' + className : '')}
    />
  )
})

export default SqlCodeEditor
