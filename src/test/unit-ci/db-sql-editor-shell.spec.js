// A-1：SQL 编辑器外壳契约测试
//
// node 单测环境没有 DOM，无法真的挂载 CM6（EditorView 需要 document）。
// 这里测的是"装配契约"——那些一旦漂移就会静默坏掉、又不会被其他用例覆盖的点：
// 懒加载边界、主题变量化、Compartment 复用、快捷键转发、查找适配、构建断言接线。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const EDITOR = path.join(ROOT, 'src/client/components/database/db-sql-editor.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const BUILD = path.join(ROOT, 'src/build/bin/build.js')
const CHECK = path.join(ROOT, 'src/build/bin/check-cm6-chunk.js')

const read = p => fs.readFileSync(p, 'utf8')

describe('A-1 懒加载边界', () => {
  test('db-session 用 React.lazy 引入编辑器，而不是静态 import', () => {
    const src = read(SESSION)
    assert.match(src, /const SqlCodeEditor = lazy\(\(\) => import\('\.\/db-sql-editor'\)\)/)
    assert.ok(!/^import .*db-sql-editor/m.test(src), '不允许静态 import 编辑器')
  })

  test('CM6 只被编辑器组件直接引用（其他文件用静态 import 就会进主 chunk）', () => {
    const offenders = []
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          walk(full)
        } else if (/\.(js|jsx|mjs)$/.test(ent.name)) {
          const text = read(full)
          if (/from '@codemirror\/|from "@codemirror\//.test(text)) {
            if (path.resolve(full) !== path.resolve(EDITOR)) {
              offenders.push(path.relative(ROOT, full))
            }
          }
        }
      }
    }
    walk(path.join(ROOT, 'src/client'))
    assert.deepEqual(offenders, [], 'CM6 只允许 db-sql-editor.jsx 直接 import')
  })

  test('构建脚本接了 chunk 断言，且失败会中止构建', () => {
    const src = read(BUILD)
    assert.match(src, /check-cm6-chunk\.js/)
    assert.match(src, /chunkCheck\.code !== 0/)
    assert.match(src, /process\.exit\(1\)/)
    assert.ok(fs.existsSync(CHECK), 'check-cm6-chunk.js 不存在')
  })

  test('断言脚本同时检查"主入口干净"和"异步 chunk 确实存在"', () => {
    const src = read(CHECK)
    assert.match(src, /cm-editor/)
    assert.match(src, /主入口/)
    assert.match(src, /chunk\//)
  })
})

describe('A-1 外壳装配', () => {
  const src = read(EDITOR)

  test('方言走 SQLDialect.define 且来源是 sql-dialects.js', () => {
    assert.match(src, /SQLDialect\.define\(/)
    assert.match(src, /from '\.\.\/\.\.\/common\/sql-dialects'/)
    // 关键字不允许在组件里另写一份
    assert.ok(!/'SELECT FROM WHERE'/.test(src))
  })

  test('方言/只读/placeholder 都走 Compartment reconfigure，不重建 EditorView', () => {
    assert.match(src, /new Compartment\(\)/)
    assert.match(src, /langCompartment\.current\.reconfigure\(/)
    assert.match(src, /roCompartment\.current\.reconfigure\(/)
    assert.match(src, /phCompartment\.current\.reconfigure\(/)
    // new EditorView 只允许出现一次（挂载时）
    const creates = src.match(/new EditorView\(/g) || []
    assert.equal(creates.length, 1, 'EditorView 只应在挂载时创建一次')
  })

  test('卸载时 destroy，避免 view 与 DOM 泄漏', () => {
    assert.match(src, /view\.destroy\(\)/)
  })

  test('只读用 readOnly + editable 双保险（可选中复制、不可编辑）', () => {
    assert.match(src, /EditorState\.readOnly\.of\(readOnly\)/)
    assert.match(src, /EditorView\.editable\.of\(!readOnly\)/)
  })

  test('快捷键保留原 textarea 的键位并转发回调', () => {
    assert.match(src, /key: 'Mod-Enter'/)
    assert.match(src, /key: 'Mod-Shift-f'/)
    assert.match(src, /cbRef\.current\.onRun/)
    assert.match(src, /cbRef\.current\.onFormat/)
  })

  test('回调通过 ref 读取最新值（避免 Ctrl+Enter 调到旧闭包）', () => {
    assert.match(src, /cbRef\.current = \{ onChange, onRun, onFormat \}/)
  })

  test('外部改值只在 doc 不一致时 dispatch（防输入循环覆盖光标）', () => {
    assert.match(src, /const cur = view\.state\.doc\.toString\(\)/)
    assert.match(src, /if \(value !== cur\)/)
  })
})

describe('A-1 主题跟随 token', () => {
  const src = read(EDITOR)

  test('外壳主题里不出现硬编码色值（除 transparent 与 color-mix 包裹的 var）', () => {
    const themeStart = src.indexOf('const shellTheme')
    assert.ok(themeStart > 0, '找不到 shellTheme')
    const themeSrc = src.slice(themeStart, src.indexOf('const SqlCodeEditor'))
    const hex = themeSrc.match(/#[0-9a-fA-F]{3,8}\b/g) || []
    assert.deepEqual(hex, [], '主题里出现十六进制色值，主题切换会残留旧色')
    const rgb = themeSrc.match(/\brgba?\(/g) || []
    assert.deepEqual(rgb, [], '主题里出现 rgb()/rgba()，应改用 CSS 变量')
  })

  test('所有颜色都通过 var(--x) 引用', () => {
    const themeStart = src.indexOf('const shellTheme')
    const themeSrc = src.slice(themeStart, src.indexOf('const SqlCodeEditor'))
    const colors = [...themeSrc.matchAll(/(?:color|backgroundColor|borderLeftColor|borderColor):\s*'([^']+)'/g)]
      .map(m => m[1])
    assert.ok(colors.length >= 8, '主题颜色项过少，可能被改写')
    for (const c of colors) {
      const ok = c === 'transparent' ||
        c.startsWith('var(--') ||
        c.startsWith('color-mix(in srgb, var(--')
      assert.ok(ok, `颜色 ${c} 不是 CSS 变量`)
    }
  })

  test('高亮样式的颜色同样只指向变量', () => {
    const start = src.indexOf('const highlightStyle')
    const styleSrc = src.slice(start, src.indexOf('const shellTheme'))
    const colors = [...styleSrc.matchAll(/color:\s*'([^']+)'/g)].map(m => m[1])
    assert.ok(colors.length >= 8)
    for (const c of colors) {
      assert.ok(c.startsWith('var(--'), `高亮色 ${c} 不是 CSS 变量`)
    }
  })

  test('样式表里的圆角用 token，不留 px 硬编码', () => {
    const styl = read(STYL)
    const block = styl.slice(styl.indexOf('.db-sql-editor'), styl.indexOf('.db-sql-bar'))
    assert.ok(block.includes('border-radius var(--radius-xs)'), '圆角必须用 --radius-xs token')
  })
})

describe('A-1 页内查找适配', () => {
  const session = read(SESSION)
  const editor = read(EDITOR)

  test('命中清单扩成三段：DOM / textarea / SQL 编辑器', () => {
    assert.match(session, /const hitsRef = useRef\(\{ marks: \[\], taHits: \[\], sqlHits: 0 \}\)/)
  })

  test('recount 向编辑器要全文命中数（CM6 只渲染可视行）', () => {
    assert.match(session, /sqlEditorRef\.current\.getSearchHits\(kw\)\.length/)
    assert.match(session, /const total = marks\.length \+ taHits\.length \+ sqlHits/)
  })

  test('导航能定位到编辑器内命中', () => {
    assert.match(session, /editor\.setSearchKeyword\(kw\)/)
    assert.match(session, /editor\.selectSearchHit\(taIndex - taHits\.length\)/)
    assert.match(session, /const n = marks\.length \+ taHits\.length \+ sqlHits/)
  })

  test('编辑器侧复用 db-search 的同一套命中算法（不另写一份）', () => {
    assert.match(editor, /import \{ scanTextHits \} from '\.\/db-search'/)
    assert.match(editor, /scanTextHits\(view\.state\.doc\.toString\(\), kw\)/)
  })
})

describe('A-1 替换干净', () => {
  const session = read(SESSION)

  test('SQL 区不再使用 antd Input.TextArea', () => {
    const area = session.slice(session.indexOf('const sqlArea ='), session.indexOf('const sqlArea =') + 900)
    assert.ok(!area.includes('Input.TextArea'), 'SQL 区仍渲染 Input.TextArea')
    assert.ok(area.includes('<SqlCodeEditor'))
    assert.ok(area.includes('Suspense'), '缺少 Suspense 包裹')
  })

  test('原 textarea 的 onKeyDown 绑定已移除（键位移进 keymap）', () => {
    assert.ok(!session.includes('onSqlKeyDown'), 'onSqlKeyDown 残留，会变成死代码')
  })

  test('骨架屏与旧 textarea 同尺寸，chunk 到位不跳动', () => {
    const styl = read(STYL)
    assert.ok(styl.includes('.db-sql-editor-skeleton'))
    assert.ok(/min-height 96px/.test(styl))
    assert.ok(/max-height 260px/.test(styl))
  })
})
