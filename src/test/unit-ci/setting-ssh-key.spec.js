const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

// 与 remote-archive-ui.spec.js 同一路线：判据读源码，不做 jsdom 渲染。
// 「漏挂分支 / 词条缺一种语言 / 口令被写进书签」这类问题不需要浏览器也照样致命
describe('G7-3 SSH 密钥面板接线契约', () => {
  const ROOT = path.join(__dirname, '../../..')
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
  const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  const CONSTS = 'src/client/common/constants.js'
  const LIST = 'src/client/common/setting-list.js'
  const TAB = 'src/client/components/setting-panel/tab-settings.jsx'
  const PANEL = 'src/client/components/setting-panel/setting-ssh-key.jsx'
  const STYL = 'src/client/components/setting-panel/setting-ssh-key.styl'
  const IPC = 'src/app/lib/ipc.js'
  const LOCALES = 'src/app/common/locales-extra.js'

  test('新分节的三处接线齐（漏一处就是左侧点了没反应）', () => {
    assert.match(read(CONSTS), /export const settingSshKeyId = 'setting-ssh-key'/)
    const list = codeOf(read(LIST))
    assert.match(list, /import \{[\s\S]*settingSshKeyId[\s\S]*\} from '\.\.\/common\/constants'/)
    assert.match(list, /id: settingSshKeyId,\s*title: e\('sshKeys'\)/)
    const tab = codeOf(read(TAB))
    assert.match(tab, /import SettingSshKey from '\.\/setting-ssh-key'/)
    assert.match(tab, /sid === settingSshKeyId/)
    assert.match(tab, /<SettingSshKey \{\.\.\.sshKeyProps\} \/>/)
    // 书签与 editItem 是回填步骤的两个入参，漏传一个按钮永远点不动
    assert.match(tab, /bookmarks: store\.bookmarks,\s*editItem: store\.editItem/)
  })

  test('面板只经 sshKeyOp 通道，动作名与主进程注册的清单逐条对得上', () => {
    const panel = codeOf(read(PANEL))
    assert.match(panel, /window\.pre\.runGlobalAsync\('sshKeyOp', action, arg\)/)
    const actions = [...new Set(
      (panel.match(/sshKeyOp\('([a-zA-Z]+)'/g) || []).map(s => s.slice("sshKeyOp('".length, -1))
    )].sort()
    const ipcSrc = codeOf(read(IPC))
    const block = ipcSrc.slice(ipcSrc.indexOf('sshKeyOp: async'))
    const registered = [...new Set(
      (block.match(/action === '([a-zA-Z]+)'/g) || []).map(s => s.slice("action === '".length, -1))
    )].sort()
    assert.deepEqual(actions, ['deleteKnownHost', 'generate', 'listKnownHosts'],
      '面板实际调用的动作与预期不符')
    for (const a of actions) {
      assert.ok(registered.includes(a), a + ' 面板在用但主进程没注册')
    }
    // readPublicKey 是留给「回看历史密钥公钥」的，面板暂未用到，别当成接线漏了
    assert.ok(registered.includes('readPublicKey'))
    // 渲染层不碰 fs
    assert.ok(!/require\('fs'\)|window\.fs/.test(panel), '渲染层不该直接读盘')
  })

  test('口令只进 generate，不进书签、不进复制、不进日志', () => {
    const panel = codeOf(read(PANEL))
    const apply = panel.slice(panel.indexOf('handleApplyBookmark'), panel.indexOf('renderSshBookmarks'))
    assert.match(apply, /privateKeyPath: result\.privateKeyPath/)
    // 内容优先于路径（bookmark-schema 约定），回填时不清空就等于没换密钥
    assert.match(apply, /privateKey: ''/)
    assert.match(apply, /authType: 'privateKey'/)
    assert.ok(!/passphrase/.test(apply), '回填书签那一步不该带口令')
    assert.ok(!/copyToClipboard\((this\.state\.passphrase|passphrase)/.test(panel), '口令不该能复制')
    assert.ok(!/console\.(log|info|warn|error)/.test(panel), '面板不打日志，避免口令外泄')
  })

  test('两次口令不一致时不发请求；名字留空交给主进程命名', () => {
    const panel = codeOf(read(PANEL))
    const gen = panel.slice(panel.indexOf('handleGenerate = async'), panel.indexOf('handleApplyBookmark'))
    const mismatchAt = gen.indexOf("e('sshKeyPassphraseMismatch')")
    const callAt = gen.indexOf("sshKeyOp('generate'")
    assert.ok(mismatchAt > -1 && callAt > -1)
    assert.ok(mismatchAt < callAt, '校验必须在发请求之前')
    assert.match(gen, /if \(passphrase !== passphrase2\)[\s\S]{0,120}return/)
    assert.match(gen, /name: name \|\| undefined/)
  })

  test('删单条要确认、只带 lineNo + fingerprint，且没有清空全部的入口', () => {
    const panel = codeOf(read(PANEL))
    assert.match(panel, /<Popconfirm/)
    assert.match(panel, /title=\{e\('knownHostsDeleteConfirm'\)\}/)
    assert.match(panel, /onConfirm=\{\(\) => this\.handleDeleteKnown\(row\)\}/)
    assert.match(panel, /lineNo: row\.lineNo,\s*fingerprint: row\.fingerprint/)
    // 一次只删一行：调用点必须恰好一处，出现第二处多半是有人加了批量/清空
    assert.equal((panel.match(/sshKeyOp\('deleteKnownHost'/g) || []).length, 1)
    // 清空全部：一次点击抹掉所有主机信任，下一次连接要么撞警告要么被顺手点掉
    assert.ok(!/clearAll|knownHostsClear/.test(panel + codeOf(read(STYL))), '不该提供清空 known_hosts')
  })

  test('哈希条目与解析不了的条目：呈现与可删性都不同', () => {
    const panel = codeOf(read(PANEL))
    assert.match(panel, /row\.hashed\s*\?\s*e\('knownHostsHashed'\)/)
    assert.match(panel, /const canDelete = !row\.malformed && !!row\.fingerprint/)
    assert.match(panel, /disabled=\{!canDelete\}/)
    // 畸形条目算不出指纹，删它必然失败，按钮直接禁用而不是让用户点了才报错
    assert.match(panel, /loading=\{deletingLine === row\.lineNo\}/)
  })

  test('不轮询、卸载后不落 state', () => {
    const panel = codeOf(read(PANEL))
    assert.ok(!/setInterval/.test(panel), '面板不该自己轮询 known_hosts')
    assert.match(panel, /componentWillUnmount \(\) \{\s*[\s\S]{0,160}this\.seq\+\+/)
    assert.match(panel, /if \(seq !== this\.seq\) \{\s*return/)
  })

  test('原文只进文本节点（主机名与公钥都不可信）', () => {
    const panel = codeOf(read(PANEL))
    assert.ok(!/dangerouslySetInnerHTML/.test(panel))
    // 指纹/路径都带 title 全文，折行不影响用户核对
    assert.match(panel, /title=\{row\.hostField\}/)
    assert.match(panel, /title=\{fp\}/)
  })

  test('词条 en + zh 各一条且都用上了', () => {
    const locales = read(LOCALES)
    const used = codeOf(read(PANEL)) + codeOf(read(LIST))
    const keys = [
      'sshKeys', 'sshKeyType', 'sshKeyName', 'sshKeyNameTip',
      'sshKeyPassphrase', 'sshKeyPassphraseConfirm', 'sshKeyGenerate', 'sshKeyGenerating',
      'sshKeyGenerated', 'sshKeyPrivatePath', 'sshKeyPublicLine', 'sshKeyEncrypted',
      'sshKeyInstall', 'sshKeyInstallManual', 'sshKeyApplyBookmark', 'sshKeyApplyTip',
      'sshKeyApplyBookmarkBtn', 'sshKeyBookmarkPlaceholder', 'sshKeyPassphraseMismatch',
      'sshKeyPassphraseNotSaved', 'sshKeyNameExists', 'sshKeyNameInvalid',
      'sshKeyPassphraseTooShort', 'sshKeyPassphraseTooLong', 'sshKeyTypeUnsupported',
      'knownHosts', 'knownHostsFile', 'knownHostsEmpty', 'knownHostsHashed',
      'knownHostsMalformed', 'knownHostsDeleteConfirm', 'knownHostsDeleted', 'knownHostsStale'
    ]
    for (const k of keys) {
      assert.equal((locales.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 2, k + ' 要 en + zh 各一条')
      assert.ok(new RegExp("e\\('" + k + "'\\)").test(used), k + ' 没被用上')
    }
    // 中文只出现在词条里，组件不写死
    const jsx = read(PANEL)
    const withoutComments = jsx.split('\n').filter(l => !/^[\s]*(\/\/|\*|\/\*)/.test(l)).join('\n')
    assert.ok(!/[\u4e00-\u9fa5]/.test(withoutComments.replace(/^\s*\/\/.*$/gm, '')),
      '组件里写死了中文，切语言不会跟着变')
  })

  test('样式与组件的类名互相咬得住（改名会让样式静默失效或留下死规则）', () => {
    const styl = read(STYL)
    const panel = read(PANEL)
    // className 允许带多个类，取整串再拆；组件里既有 JSX 属性写法也有 props 对象写法
    const used = new Set()
    for (const m of codeOf(panel).matchAll(/className(?:=|:)\s*'([^']+)'/g)) {
      for (const c of m[1].split(/\s+/)) {
        if (c.startsWith('ssh-key-')) {
          used.add(c)
        }
      }
    }
    assert.ok(used.size >= 20, '只抓到 ' + used.size + ' 个类名，判据没在真组件上跑')
    const styled = new Set((styl.match(/\.ssh-key-[a-z-]+/g) || []).map(s => s.slice(1)))
    assert.ok(styled.size >= 15, '样式表里只有 ' + styled.size + ' 条规则，大概没在管这些类')
    for (const c of styled) {
      assert.ok(used.has(c), c + ' 有样式但组件里找不到，规则已死')
    }
    // 反过来只要求组件里的容器类有落点：按钮/网格单元那类纯钩子可以不留规则
    for (const c of ['ssh-key-wizard', 'ssh-key-result', 'ssh-key-known-list', 'ssh-key-known-row']) {
      assert.ok(styled.has(c), c + ' 是容器却没有样式')
    }
  })
})
