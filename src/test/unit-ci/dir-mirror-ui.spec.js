// G5 目录镜像（界面层）接线契约
// 弹层不好在无 jsdom 的 CI 里渲染，这里钉的是"致命的接线错误"：漏挂 Modal、
// 入口判据写反、词条只写了一半、执行层偷偷自己搬字节、删除勾选没被采集完整性挡住。
// 纯函数（差异、采集）的行为归 dir-mirror.spec.js / dir-mirror-walk.spec.js。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const MODAL = 'src/client/components/sftp/dir-mirror-modal.jsx'
const STYL = 'src/client/components/sftp/dir-mirror-modal.styl'
const ITEM = 'src/client/components/sftp/file-item.jsx'
const MAIN = 'src/client/components/main/main.jsx'
const LOCALES = 'src/app/common/locales-extra.js'
const ICONS = 'src/client/components/sys-menu/icons-map.jsx'

const WALK = path.join(ROOT, 'src/client/common/dir-mirror-walk.js')
const DIFF = path.join(ROOT, 'src/client/common/dir-mirror.js')

let mods
const load = async () => {
  if (!mods) {
    mods = {
      walk: await import(pathToFileURL(WALK).href),
      diff: await import(pathToFileURL(DIFF).href)
    }
  }
  return mods
}

describe('G5 镜像弹层：mode 透传（采集 -> 差异 -> 明细行）', () => {
  test('本地/远端适配器只在拿得到 mode 时带上这个键', async () => {
    const { walk } = await load()
    assert.equal(walk.localEntryToNode({ name: 'a', mode: 0o100644 }).mode, 0o100644)
    assert.equal('mode' in walk.localEntryToNode({ name: 'a' }), false, '没有 mode 不能写成 undefined')
    assert.equal('mode' in walk.localEntryToNode({ name: 'a', mode: 'x' }), false)
    assert.equal('mode' in walk.localEntryToNode({ name: 'a', mode: 0 }), false, '0 当"拿不到"')
    assert.equal(walk.remoteEntryToNode({ name: 'a', mode: 0o40755 }).mode, 0o40755)
    assert.equal('mode' in walk.remoteEntryToNode({ name: 'a' }), false)
  })

  test('采集结果的条目带 mode，读不到的条目不带（不会给传输层塞 0）', async () => {
    const { walk } = await load()
    const r = await walk.walkTree({
      root: '/root',
      readDir: () => [
        { name: 'a.txt', size: 1, mtimeMs: 1000, mode: 0o100600 },
        { name: 'b.txt', size: 1, mtimeMs: 1000 }
      ],
      mapEntry: walk.localEntryToNode
    })
    assert.equal(r.entries[0].mode, 0o100600)
    assert.equal('mode' in r.entries[1], false)
  })

  test('差异分组把 mode 带到明细行（上传要按它保留权限）', async () => {
    const { diff, walk } = await load()
    const d = diff.diffTrees(
      [{ relPath: 'a.txt', size: 1, mtimeMs: 1, mode: 0o100644 }],
      [],
      {}
    )
    assert.equal(d.create[0].mode, 0o100644)
    const e2 = walk.remoteEntryToNode({ name: 'b', size: 2, modifyTime: 1700000000 })
    assert.equal(e2.mode, undefined, '远端不给 mode 就不带')
    const d2 = diff.diffTrees(
      [{ relPath: 'b.txt', size: 2, mtimeMs: 1700000000000 }],
      [{ relPath: 'c.txt', size: 3, mtimeMs: 1 }]
    )
    assert.equal('mode' in d2.create[0], false)
    assert.equal('mode' in d2.remoteExtra[0], false)
  })
})

describe('G5 镜像弹层：接线契约', () => {
  test('弹层是 refsStatic 组件且挂到了主界面（漏挂 = 右键点了没反应）', () => {
    const src = read(MODAL)
    assert.match(src, /class DirMirrorModal extends React\.PureComponent/)
    assert.match(src, /refsStatic\.add\('dir-mirror-modal', this\)/)
    assert.match(src, /import Modal from '\.\.\/common\/modal'/)
    assert.match(src, /<Modal[\s\S]*className='dir-mirror-modal'/)
    const main = read(MAIN)
    assert.match(main, /import DirMirrorModal from '\.\.\/sftp\/dir-mirror-modal'/)
    assert.match(main, /<DirMirrorModal \/>/)
  })

  test('入口只给"本地真实目录 + 有 SFTP 会话 + 非 FTP"，完成后刷新远端', () => {
    const src = codeOf(read(ITEM))
    assert.match(src, /mirrorDir = \(\) => \{/)
    assert.match(src, /refsStatic\.get\('dir-mirror-modal'\)\?\.showMirror\(\{/)
    const gate = src.slice(src.indexOf('const canMirrorDir'), src.indexOf("func: 'mirrorDir'"))
    assert.match(gate, /isLocal/)
    assert.match(gate, /isDirectory/)
    assert.match(gate, /isRealFile/)
    assert.match(gate, /hasHost/)
    assert.match(gate, /!!this\.props\.sftp/)
    assert.match(gate, /!this\.props\.isFtp/)
    // 源目录 = 右键那项本身，目标默认落到远端当前目录
    assert.match(src, /dir: resolve\(file\.path, file\.name\)/)
    assert.match(src, /remotePath,/)
    assert.match(src, /onDone: \(\) => this\.props\.remoteList\(\)/)
  })

  test('菜单图标在图标表里 import + 导出各一处', () => {
    const src = read(ICONS)
    assert.equal((src.match(/\bSwapOutlined\b/g) || []).length, 2)
  })

  test('词条中英成对：每个 dirMirror* key 在 en 与 zh_cn 各出现一次', () => {
    const src = read(LOCALES)
    const keys = [...src.matchAll(/^\s{2}(dirMirror[A-Za-z0-9]+):/gm)].map(m => m[1])
    assert.ok(keys.length > 30, '词条数量不像话：' + keys.length)
    const count = new Map()
    for (const k of keys) {
      count.set(k, (count.get(k) || 0) + 1)
    }
    const bad = [...count].filter(([, n]) => n !== 2)
    assert.deepEqual(bad, [], '有 key 不是中英文各一处：' + bad.map(b => b.join('x')).join(', '))
    const extra = require(path.join(ROOT, LOCALES))
    for (const k of count.keys()) {
      assert.ok(Object.prototype.hasOwnProperty.call(extra.en, k), k + ' 不在 en')
      assert.ok(Object.prototype.hasOwnProperty.call(extra.zh_cn, k), k + ' 不在 zh_cn')
    }
  })

  test('界面里用到的每个 e(\'dirMirror*\') 都有词条', () => {
    const extra = require(path.join(ROOT, LOCALES))
    const used = new Set()
    for (const m of read(MODAL).matchAll(/e\(\s*'(dirMirror[^']+)'\s*\)/g)) {
      used.add(m[1])
    }
    for (const m of read(MODAL).matchAll(/'(dirMirror[A-Za-z0-9]+)'/g)) {
      used.add(m[1])
    }
    const miss = [...used].filter(k =>
      !Object.prototype.hasOwnProperty.call(extra.en, k) &&
      !Object.prototype.hasOwnProperty.call(extra.zh_cn, k)
    )
    assert.ok(used.size > 20, '扫到的 key 太少：' + used.size)
    assert.deepEqual(miss, [], '缺词条：' + miss.join(', '))
  })

  test('搬运字节全交给现有传输队列：弹层里没有 upload / writeFile / 自建并发', () => {
    const src = codeOf(read(MODAL))
    assert.match(src, /window\.store\.addTransferList\(uploads\)/)
    for (const bad of ['sftp.upload', 'window.fs.writeFile', 'new Worker', 'Promise.allSettled']) {
      assert.equal(src.includes(bad), false, '不该出现 ' + bad)
    }
    // 远端只直接做两件事：建缺的目录、删勾选了才列出的多余文件
    assert.match(src, /await sftp\.mkdir\(/)
    assert.match(src, /await sftp\.rm\(/)
  })

  test('覆盖项预置冲突策略，否则几千个文件会逐个弹冲突框', () => {
    const src = codeOf(read(MODAL))
    assert.match(src, /obj\.resolvePolicy = fileActions\.mergeOrOverwrite/)
    assert.match(src, /diff\.overwrite\.map\(f => this\.buildTransfer\(f, true\)\)/)
    assert.match(src, /diff\.create\.map\(f => this\.buildTransfer\(f, false\)\)/)
  })

  test('删除勾选：默认关 + 两端采齐才可勾 + 执行前再看一次', () => {
    const src = codeOf(read(MODAL))
    assert.match(src, /deleteExtra: false/)
    assert.match(src, /canDelete: !!\(lw\.complete && rw\.complete\)/)
    assert.match(src, /disabled=\{!editable \|\| !canDelete\}/)
    assert.match(src, /if \(deleteExtra && !this\.state\.canDelete\) \{/)
    // 改判断依据/勾选只对已采回来的树重算，不重新采集
    const mode = src.slice(src.indexOf('handleModeChange ='), src.indexOf('handleDeleteExtraChange ='))
    assert.match(mode, /this\.applyDiff\(\)/)
    assert.equal(mode.includes('handleScan'), false, '改判据不该重新采集')
  })

  test('明细有渲染上限，且截断要写在界面上', () => {
    const src = codeOf(read(MODAL))
    assert.match(src, /const PLAN_LIMIT = 500/)
    assert.match(src, /planRows\(diff, \{ limit: PLAN_LIMIT \}\)/)
    assert.match(src, /plan\.truncated/)
  })

  test('执行中关不掉、采集中可叫停、关窗前先停采集', () => {
    const src = codeOf(read(MODAL))
    assert.match(src, /if \(this\.state\.phase === 'running'\) \{\n\s*return/)
    assert.match(src, /maskClosable=\{phase !== 'running'\}/)
    assert.match(src, /this\.cancelWalk = true\n\s*this\.stopTicker\(\)/)
    assert.match(src, /isCancelled,/)
  })

  test('样式只用 token，不写死颜色', () => {
    const src = read(STYL)
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(src), false, '出现硬编码色值')
    assert.equal(/\brgba?\(/.test(src), false, '出现硬编码色值')
    for (const t of ['--text', '--text-dark', '--border', '--error', '--warn', '--primary', '--radius-sm', '--font-mono', '--hover-bg']) {
      assert.ok(src.includes('var(' + t + ')'), '应用到 var(' + t + ')')
    }
  })

  test('不抢 Enter/空格：执行按钮不能带 custom-modal-ok-btn 这个类', () => {
    const src = read(MODAL)
    assert.equal(src.includes("className='custom-modal-ok-btn'"), false,
      '共享 Modal 会把该按钮绑到 Enter/空格，而它会写远端甚至删文件')
  })
})
