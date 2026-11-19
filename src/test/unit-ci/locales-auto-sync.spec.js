/**
 * 语言包自动同步契约：打包脚本「检测上游新版 → bump 本地锁」这一环。
 *
 * 背景：翻译真相源在独立 npm 包 @electerm/electerm-locales，本 fork 用精确版本
 * 锁定。上游发新版后，--prepare 也只是重装同一锁版本，永远拿不到新翻译。
 * sync-locales.js 补上检测+bump；build-deb-fast.js 在依赖指纹计算之前调用，
 * bump 后指纹变化 → 自动 prepare → 重装新包 → patch-locales 补本地词。
 *
 * 本 spec 只锁源码事实与纯函数行为，不联网、不改真实 package.json：
 *   - 版本比较 / 解析 / 决策函数为纯函数，逐项断言；
 *   - run() 用注入 exec + dryRun 走完整决策链；
 *   - build-deb-fast.js 的调用点必须在 depsChanged 之前，且有跳过开关。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const sync = require(path.join(ROOT, 'src/build/bin/sync-locales.js'))

describe('sync-locales 纯函数：版本解析与比较', () => {
  it('parseVersion 解析标准点分版本，忽略 prerelease 尾巴', () => {
    assert.deepEqual(sync.parseVersion('2.3.39'), [2, 3, 39])
    assert.deepEqual(sync.parseVersion('v10.0.1-beta.2'), [10, 0, 1])
    assert.equal(sync.parseVersion('latest'), null)
    assert.equal(sync.parseVersion(''), null)
    assert.equal(sync.parseVersion(undefined), null)
  })

  it('isNewer 逐段比较，相等返回 false，非法版本保守不 bump', () => {
    assert.equal(sync.isNewer('2.3.40', '2.3.39'), true)
    assert.equal(sync.isNewer('3.0.0', '2.99.99'), true)
    assert.equal(sync.isNewer('2.4.0', '2.3.99'), true)
    assert.equal(sync.isNewer('2.3.39', '2.3.39'), false)
    assert.equal(sync.isNewer('2.3.38', '2.3.39'), false)
    assert.equal(sync.isNewer('bad', '2.3.39'), false)
    assert.equal(sync.isNewer('2.3.40', 'bad'), false)
  })

  it('parseLatestOutput 从 npm view 多行输出中提取首个合法版本', () => {
    assert.equal(sync.parseLatestOutput('2.3.40\n'), '2.3.40')
    assert.equal(sync.parseLatestOutput('notes\nsome text\n2.4.1'), '2.4.1')
    assert.equal(sync.parseLatestOutput('npm ERR! network'), null)
    assert.equal(sync.parseLatestOutput(null), null)
  })

  it('decide 三种决策：bump / current / skip', () => {
    assert.deepEqual(sync.decide('2.3.39', '2.3.40'), {
      action: 'bump', from: '2.3.39', to: '2.3.40'
    })
    assert.deepEqual(sync.decide('2.3.39', '2.3.39'), {
      action: 'current', version: '2.3.39'
    })
    assert.deepEqual(sync.decide('2.3.39', null), {
      action: 'skip', reason: 'no-latest'
    })
    assert.deepEqual(sync.decide(null, '2.3.40'), {
      action: 'skip', reason: 'no-local'
    })
  })
})

describe('sync-locales 查询链：国内镜像优先 + 失败降级', () => {
  it('queryLatest 优先用第一个镜像，成功即返回', () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push(args.find(a => a.startsWith('--registry=')))
      if (args.includes('version')) return '2.3.50\n'
      return ''
    }
    const res = sync.queryLatest(exec, ['https://mirror-a', 'https://mirror-b'])
    assert.equal(res.version, '2.3.50')
    assert.equal(res.registry, 'https://mirror-a')
    assert.equal(calls.length, 1)
  })

  it('queryLatest 第一个镜像失败时回落第二个', () => {
    const exec = (cmd, args) => {
      const reg = args.find(a => a.startsWith('--registry='))
      if (reg.includes('mirror-a')) throw new Error('ECONNREFUSED')
      return '2.3.51'
    }
    const res = sync.queryLatest(exec, ['https://mirror-a', 'https://mirror-b'])
    assert.equal(res.version, '2.3.51')
    assert.equal(res.registry, 'https://mirror-b')
  })

  it('queryLatest 全失败返回 error，不带 version', () => {
    const exec = () => { throw new Error('offline') }
    const res = sync.queryLatest(exec, ['https://a'])
    assert.ok(res.error)
    assert.equal(res.version, undefined)
  })
})

describe('sync-locales run()：完整决策链（注入 exec + dryRun，不改真实文件）', () => {
  it('dryRun 检测到新版只报告、不写文件', () => {
    const logs = []
    const writes = []
    const exec = (cmd, args) => {
      if (args.includes('version')) return '2.3.40'
      writes.push([cmd, args])
      return ''
    }
    // 注入一个只读 pkgPath（真实存在但 dryRun 不写），用真实文件读取
    const res = sync.run({
      pkgPath: path.join(ROOT, 'package.json'),
      lockPath: path.join(ROOT, 'package-lock.json'),
      dryRun: true,
      exec,
      registries: ['https://mirror'],
      log: s => logs.push(s)
    })
    assert.equal(res.action, 'bump')
    assert.equal(res.to, '2.3.40')
    assert.equal(res.dryRun, true)
    assert.equal(writes.length, 0, 'dryRun 不得执行任何 npm install')
    assert.ok(logs.some(l => l.includes('2.3.40')))
  })

  it('已是最新时不触发 bump', () => {
    const exec = (cmd, args) => args.includes('version') ? '2.3.39' : ''
    const res = sync.run({
      pkgPath: path.join(ROOT, 'package.json'),
      dryRun: true,
      exec,
      registries: ['https://mirror'],
      log: () => {}
    })
    assert.equal(res.action, 'current')
  })

  it('查询失败时降级 skip，不抛异常', () => {
    const exec = () => { throw new Error('offline') }
    const res = sync.run({
      pkgPath: path.join(ROOT, 'package.json'),
      dryRun: true,
      exec,
      registries: ['https://mirror'],
      log: () => {}
    })
    assert.equal(res.action, 'skip')
    assert.equal(res.reason, 'query-failed')
  })

  it('package.json 读取失败时降级 skip', () => {
    const res = sync.run({
      pkgPath: '/nonexistent/path/package.json',
      dryRun: true,
      exec: () => '',
      log: () => {}
    })
    assert.equal(res.action, 'skip')
    assert.equal(res.reason, 'read-error')
  })
})

describe('build-deb-fast 接入契约', () => {
  const src = read('src/build/bin/build-deb-fast.js')

  it('在依赖指纹计算之前调用 sync-locales', () => {
    const syncAt = src.indexOf("require('./sync-locales').run()")
    const driftAt = src.indexOf('const depsDrift = depsChanged()')
    assert.ok(syncAt > 0, '必须调用 sync-locales')
    assert.ok(driftAt > 0, '必须有依赖指纹判定')
    assert.ok(syncAt < driftAt, '同步必须在指纹计算之前，bump 才能触发 prepare')
  })

  it('提供 --no-sync-locales 跳过开关', () => {
    assert.match(src, /--no-sync-locales/)
    assert.match(src, /skipSyncLocales/)
    assert.match(src, /if \(skipSyncLocales\)/)
  })

  it('同步异常被 try/catch 吞掉，不阻断打包', () => {
    assert.match(src, /语言包同步异常，忽略（不阻断打包）/)
  })
})
