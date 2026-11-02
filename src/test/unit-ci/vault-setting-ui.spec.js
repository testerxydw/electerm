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
