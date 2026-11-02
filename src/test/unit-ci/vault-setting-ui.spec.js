// G6-3 Vault 界面层接线契约
//
// 组件不好在无 jsdom 的 CI 里渲染，这里钉"致命的接线错误"：词条只写了一半、
// 页签没挂上去、底栏忘了挂锁头、Web 版给了一个点开就报错的保险库页、
// 以及最要紧的一条——阶段① 的界面不许偷偷去碰凭据的加解密与落盘。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const PANEL = 'src/client/components/setting-panel/setting-vault.jsx'
const LOCK = 'src/client/components/setting-panel/vault-lock.jsx'
const FORM = 'src/client/components/bookmark-form/form-renderer.jsx'
const LIST = 'src/client/common/setting-list.js'
const TABS = 'src/client/components/setting-panel/tab-settings.jsx'
const FOOTER = 'src/client/components/footer/footer-entry.jsx'
const LOCALES = 'src/app/common/locales-extra.js'

const extra = require(path.join(ROOT, LOCALES))

describe('词条成对', () => {
  it('每个 vault* key 中英文各一处，且两边都有', () => {
    const src = read(LOCALES)
    const keys = [...src.matchAll(/^\s{2}(vault[A-Za-z0-9]+):/gm)].map(m => m[1])
    assert.ok(keys.length > 40, '词条数量不像话：' + keys.length)
    const count = new Map()
    for (const k of keys) {
      count.set(k, (count.get(k) || 0) + 1)
    }
    const bad = [...count].filter(([, n]) => n !== 2)
    assert.deepEqual(bad, [], '有 key 不是中英文各一处：' + bad.map(b => b.join('x')).join(', '))
    for (const k of count.keys()) {
      assert.ok(Object.prototype.hasOwnProperty.call(extra.en, k), k + ' 不在 en')
      assert.ok(Object.prototype.hasOwnProperty.call(extra.zh_cn, k), k + ' 不在 zh_cn')
    }
  })

  it('界面里用到的每个 vault* 词条都存在（缺一个就会把驼峰 key 甩到屏幕上）', () => {
    const used = new Set()
    for (const f of [PANEL, LOCK]) {
      // 只认 e('...')：源码里还有 'vaultOp'（IPC 名）这类不是文案的字符串
      for (const m of read(f).matchAll(/e\(\s*'(vault[A-Za-z0-9]+)'\s*\)/g)) {
        used.add(m[1])
      }
    }
    // 状态文案是 vaultState + 首字母大写的态名拼出来的，源码里搜不到，得显式列进来
    for (const k of ['vaultStateOff', 'vaultStateLocked', 'vaultStateUnlocked', 'vaultStateError']) {
      used.add(k)
    }
    const missing = [...used].filter(k => !Object.prototype.hasOwnProperty.call(extra.en, k))
    assert.deepEqual(missing, [], '缺 en 词条：' + missing.join(', '))
    const missingZh = [...used].filter(k => !Object.prototype.hasOwnProperty.call(extra.zh_cn, k))
    assert.deepEqual(missingZh, [], '缺 zh_cn 词条：' + missingZh.join(', '))
  })
})

describe('入口接线', () => {
  it('设置页签注册了保险库，且 Web 版把它滤掉', () => {
    const list = read(LIST)
    assert.match(list, /settingVaultId/)
    assert.match(list, /title: e\('vault'\)/)
    assert.match(list, /isWebApp[\s\S]*settingVaultId/, 'Web 版没有主进程保险库能力，页签不该出现')
    assert.match(read(TABS), /sid === settingVaultId/)
    assert.match(read(TABS), /<SettingVault/)
  })

  it('底栏挂了锁头（解锁弹窗与自动锁续期都在它里面），且 Web 版不挂', () => {
    const footer = read(FOOTER)
    assert.match(footer, /import VaultLock from/)
    assert.match(footer, /isWebApp[\s\S]{0,40}<VaultLock \/>/, 'Web 版没有主进程保险库，连状态都不该去问')
  })

  it('界面只经一条 vaultOp 通道找主进程，动作名都在服务白名单里', () => {
    const handlers = read('src/app/lib/vault.js').match(/const handlers = \{([\s\S]*?)\n\s{2}\}/)
    assert.ok(handlers, '读不到 vault 服务的 handlers 清单')
    const known = new Set(
      [...handlers[1].matchAll(/^\s+([a-zA-Z]+),?$/gm)].map(m => m[1])
    )
    // 迁移/反解这几个动作没进服务层 handlers，而是 vault-instance 先拦截：
    // 它们要碰 DB，服务层不该知道 DB 的存在
    const instance = read('src/app/lib/vault-instance.js')
    const intercepted = [...instance.matchAll(/action === '([a-zA-Z]+)'/g)].map(m => m[1])
    for (const a of intercepted) known.add(a)
    assert.ok(known.size >= 9, '服务动作比想象少：' + [...known].join(', '))
    const src = read(PANEL) + read(LOCK)
    const callRe = /(?:vaultOp|this\.run)\(\s*(?:[\w.]+\s*\?\s*)?'([a-zA-Z]+)'(?:\s*:\s*'([a-zA-Z]+)')?/g
    const used = new Set()
    for (const m of src.matchAll(callRe)) {
      used.add(m[1])
      if (m[2]) {
        used.add(m[2])
      }
    }
    assert.ok(used.size >= 8, '动作太少，可能没扫到：' + [...used].join(', '))
    const offList = [...used].filter(a => !known.has(a))
    assert.deepEqual(offList, [], '这些动作不在主进程白名单：' + offList.join(', '))
    // IPC 通道只有一条：界面不许自己去够别的 action
    assert.equal(/runGlobalAsync\('(?!vaultOp')/.test(src), false, '除 vaultOp 外不该再有别的 IPC 通道')
  })
})

describe('明文与越权边界', () => {
  it('两个组件都不打日志、不 import 加密模块、不碰凭据落盘', () => {
    for (const f of [PANEL, LOCK]) {
      const src = read(f)
      assert.equal(/console\./.test(src), false, f + ' 不许打日志（口令可能就在参数里）')
      assert.equal(/require\('crypto'\)|from 'crypto'/.test(src), false, f + ' 不该自己做加密')
      assert.equal(/electron/.test(src), false, f + ' 是渲染层，不该 require electron')
      // 阶段① 的口径：界面不接管凭据的加解密与写入
      for (const banned of ['sealSecret', 'openSecret', 'dbAction', 'safeEncrypt', 'withDek']) {
        assert.equal(src.includes(banned), false, f + ' 阶段① 不该出现 ' + banned)
      }
    }
  })

  it('成功动作后清空输入框（明文不在 React state 里过夜）', () => {
    const lock = read(LOCK)
    assert.match(lock, /setPassword\(''\)/)
    assert.match(lock, /setRecovery\(''\)/)
    const panel = read(PANEL)
    assert.match(panel, /clearSection\(/)
    assert.match(panel, /const result = await this\.run\([\s\S]*?'enable',\s*\{ masterPassword, autoLockMin \},\s*'enable'/)
  })

  it('锁着不发续期请求（判据在纯模块里，组件不许绕过）', () => {
    const lock = read(LOCK)
    assert.match(lock, /shouldTouch\(/)
    assert.match(lock, /vaultOp\('touch'\)/)
    assert.match(lock, /statusPollMs/, '没建库不轮询：轮询节奏也走同一个判据')
    assert.match(lock, /shouldPoll\(/)
  })

  it('恢复码只在 enable 返回后显示一次，组件不留第二份来源', () => {
    const panel = read(PANEL)
    assert.equal(
      (panel.match(/result\.recoveryCode/g) || []).length,
      1,
      '恢复码只该来自 enable 那一次返回'
    )
    assert.match(panel, /vaultRecoveryOnce/)
    assert.match(panel, /vaultRecoveryWarn/)
  })

  it('恢复码挂在 render，不挂在建库表单里（建好库那一刻表单就换成管理视图）', () => {
    const panel = read(PANEL)
    const body = panel.match(/renderBody \(\) \{[\s\S]*?\n {2}\}/)
    const enable = panel.match(/renderEnable \(\) \{[\s\S]*?\n {2}\}/)
    const render = panel.match(/\n {2}render \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(body && enable && render, 'renderBody/renderEnable/render 有一个改名了，判据要先跟着改')
    assert.equal(body[0].includes('renderRecovery'), false, '管理视图里不该再渲染恢复码（由 render 统一挂）')
    assert.equal(enable[0].includes('renderRecovery'), false, '恢复码不能只在建库表单里渲染')
    assert.match(render[0], /recoveryCode \? this\.renderRecovery\(recoveryCode\)/)
  })
})

describe('输入取值契约', () => {
  // 真机上踩过：setField 把事件剥了两层（e.target.target.value），
  // 主密码框敲进去的字全被受控 input 还原成空 —— 界面看着正常，其实就是打不进字。
  it('setField 只走 fieldValue，不许在组件里自己写剥层逻辑', () => {
    const panel = read(PANEL)
    const body = panel.match(/setField = \(section, key\)[\s\S]*?\n {2}\}/)
    assert.ok(body, 'setField 找不到了，判据要先跟着改')
    assert.match(body[0], /fieldValue\(/, '取值必须交给纯函数，才有条单测钉得住')
    for (const f of [PANEL, LOCK]) {
      assert.equal(/\.target\.target/.test(read(f)), false, f + ' 里有双层剥的取值')
    }
  })

  it('两个组件的口令框都接了 onChange（漏一个就是打不进字）', () => {
    const panel = read(PANEL)
    const lock = read(LOCK)
    const inputs = [...panel.matchAll(/<Input(?:\.Password|\.TextArea|Number)?\b/g)]
    assert.ok(inputs.length >= 6, '面板输入框数量不像话：' + inputs.length)
    assert.ok(/onChange: this\.setField\(/.test(panel), '面板口令框靠 props 里的 onChange 接线')
    assert.ok(/onChange=\{evt => set(Recovery|Password)\(evt\.target\.value\)\}/.test(lock), '解锁框没接 onChange')
  })
})

describe('状态同步总线接线', () => {
  // 真机上踩过：'off' 态故意不轮询，于是设置页建完库，底栏锁头到下次重启才出现。
  it('面板每个成功动作都发通知，且带自己的 source', () => {
    const panel = read(PANEL)
    const run = panel.match(/run = async \(action, arg, section, okText\)[\s\S]*?\n {2}\}/)
    assert.ok(run, 'run 找不到了，判据要先跟着改')
    assert.match(run[0], /notifyVaultChange\('setting-vault'\)/)
    // 通知必须发在"确认成功"之后，失败的动作不该惊动别人
    const notify = run[0].indexOf('notifyVaultChange')
    const bail = run[0].indexOf('result.ok !== true')
    assert.ok(bail >= 0 && notify > bail, '失败分支提前 return 之后再发通知')
  })

  it('两个组件都订阅总线并在卸载时退订', () => {
    const panel = read(PANEL)
    const lock = read(LOCK)
    assert.match(panel, /onVaultChange\(/)
    assert.match(lock, /onVaultChange\(/)
    assert.match(panel, /this\.offNotify\(\)/)
    assert.match(lock, /offNotify\(\)/)
    // 自己发的通知自己不再处理，否则一次动作读两遍盘
    assert.match(panel, /src !== 'setting-vault'/)
    assert.match(lock, /src !== 'vault-lock'/)
  })

  it('锁头状态翻转时代发通知（自动到期设置页也要跟着变）', () => {
    const lock = read(LOCK)
    const refresh = lock.match(/const refresh = async \(\)[\s\S]*?\n {2}\}/)
    assert.ok(refresh, 'refresh 找不到了，判据要先跟着改')
    assert.match(refresh[0], /vaultState\(prev\) !== vaultState\(next\)/)
    assert.match(refresh[0], /notifyVaultChange\('vault-lock'\)/)
    // 首次读盘（prev 为 null）不发：那只是启动加载，不是状态变了
    assert.match(refresh[0], /if \(prev && /)
  })

  it('面板静默重读不碰 seq、不摆 loading（正在提交的 enable 不能被打断）', () => {
    const panel = read(PANEL)
    const quiet = panel.match(/reloadQuietly = async \(\)[\s\S]*?\n {2}\}/)
    assert.ok(quiet, 'reloadQuietly 找不到了，判据要先跟着改')
    assert.equal(quiet[0].includes('this.seq'), false, '静默重读不许 bump seq')
    assert.equal(quiet[0].includes('loading'), false, '静默重读不许把表单闪成加载中')
    assert.match(quiet[0], /this\.state\.busy/)
  })
})

describe('样式契约', () => {
  it('新样式不带硬编码色值，也不带非 token 的圆角', () => {
    const styl = read('src/client/components/setting-panel/setting-vault.styl')
    const lines = styl.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'))
    const badColor = lines.filter(l => /#[0-9a-fA-F]{3,8}\b/.test(l))
    assert.deepEqual(badColor, [], '硬编码色值：' + badColor.join(' | '))
    const badRadius = lines.filter(l => /border-radius\s+\d/.test(l))
    assert.deepEqual(badRadius, [], '圆角必须走 token：' + badRadius.join(' | '))
    assert.equal(/box-shadow/.test(styl), false, '新组件不引入阴影')
  })
})

describe('阶段② 迁移 / 兼容写入 / 表单锁定提示', () => {
  it('迁移块的读写都走 vaultOp，且只在有活要干时出现', () => {
    // 读（loadMigration）/ 跑批（handleMigrate）/ 渲染（renderMigration）各管一段，
    // 分开取函数体才不会因为"动作没写在渲染函数里"误判
    const src = read(PANEL)
    const load = src.match(/loadMigration = async \(\) => \{[\s\S]*?\n {2}\}/)
    const run = src.match(/handleMigrate = async \(\) => \{[\s\S]*?\n {2}\}/)
    const view = src.match(/renderMigration \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(load && run && view, '迁移相关方法改名了，判据要先跟着改')
    assert.match(load[0], /vaultOp\('migrateStatus'\)/, '进度得来自只读的 migrateStatus')
    assert.match(run[0], /vaultOp\('migrate'/, '跑批走 migrate（带 limit）')
    assert.match(view[0], /vaultMigrateResume/)
    assert.match(view[0], /vaultMigrateLater/)
    // 显示条件：库里还挂着 migrating 标记，或者还有旧格式行
    assert.match(view[0], /status\.migrating/)
    assert.match(view[0], /migration\.plain/)
  })

  it('legacyWrite 走统一动作入口，且带说明词条', () => {
    const body = read(PANEL).match(/renderLegacyWrite \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(body, 'renderLegacyWrite 找不到了，判据要先跟着改')
    assert.match(body[0], /this\.run\('setLegacyWrite'/)
    assert.match(read(PANEL), /vaultLegacyWriteHint/)
  })

  it('停用前反解提示只在确有封存行时渲染', () => {
    const body = read(PANEL).match(/renderDisable \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(body, 'renderDisable 找不到了，判据要先跟着改')
    assert.match(body[0], /vaultUnsealBeforeDisable/)
    assert.match(body[0], /sealed/)
    assert.match(body[0], /sealed\s*>\s*0/)
  })

  it('书签表单的锁定提示走总线订阅，只经 vaultOp 通道', () => {
    const src = read(FORM)
    assert.match(src, /onVaultChange/)
    assert.match(src, /vaultState\(/)
    assert.match(src, /runGlobalAsync\('vaultOp'/)
    assert.match(src, /vaultSealedFormHint/)
  })

  it('unseal-failed 有词条映射，且中英文都在', () => {
    assert.match(
      read('src/client/common/vault-ui.js'),
      /'unseal-failed':\s*'vaultUnsealFailed'/,
      '反解失败要翻成人话，别把 reason 原文甩到屏幕上'
    )
    for (const lang of ['en', 'zh_cn']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(extra[lang], 'vaultUnsealFailed'),
        'vaultUnsealFailed 不在 ' + lang
      )
    }
  })

  it('阶段② 九个新词条中英文各一处', () => {
    const keys = [
      'vaultMigrating',
      'vaultMigrateResume',
      'vaultMigrateLater',
      'vaultMigrateIntro',
      'vaultLegacyWrite',
      'vaultLegacyWriteHint',
      'vaultSealedFormHint',
      'vaultUnsealBeforeDisable',
      'vaultUnsealFailed'
    ]
    const src = read(LOCALES)
    for (const k of keys) {
      const hits = (src.match(new RegExp('\\n {2}' + k + ':', 'g')) || []).length
      assert.equal(hits, 2, k + ' 不是中英文各一处：' + hits)
      assert.ok(Object.prototype.hasOwnProperty.call(extra.en, k), k + ' 不在 en')
      assert.ok(Object.prototype.hasOwnProperty.call(extra.zh_cn, k), k + ' 不在 zh_cn')
    }
  })
})
