const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// 本文件是「规则形状 / 配色 / 引擎等价」契约测试：断言某条正则染成某色、两端同跨度。
// V2 批次 3 的行级覆盖率闸是独立的密度策略层，会把高占比行的 structure 命中丢掉，
// 那属于 keyword-density.spec.js 的验收范围。这里统一关闸，保持契约断言的原意。
const loadAddon = async () => {
  const mod = await import('../../client/components/terminal/highlight-addon.js')
  return {
    ...mod,
    KeywordHighlighterAddon: class extends mod.KeywordHighlighterAddon {
      constructor (keywords, opts = {}) {
        super(keywords, { coverageGate: false, ...opts })
      }
    }
  }
}
const loadPresets = () => import('../../client/common/keyword-presets.js')
const loadGroups = () => import('../../client/common/keyword-groups.js')

const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
// 真彩色（#rrggbb）经 keyword-compile 编译后的 ANSI 序列，供断言比对。
// B-1「一色一语义」之后，结构档全部离开上面七个语义名，所以这里覆盖 16 个结构色组
// （keyword-presets.js 的 COLOR_GROUPS）；语义名只留在 signal 档上，仍按主题映射。
// 本表是 COLOR_GROUPS 的字面快照（CJS 侧同步拿不到 ESM 导出）；色板换色后由
// 「TC 快照与 COLOR_GROUPS 同源」那条测试点名过期键。
const TC = {
  ts: '\u001b[38;2;62;209;255m', // 色组 time #3ED1FF
  dur: '\u001b[38;2;0;213;194m', // 色组 duration #00D5C2
  size: '\u001b[38;2;171;211;255m', // 色组 size #ABD3FF
  num: '\u001b[38;2;110;189;254m', // 色组 number #6EBDFE
  hex: '\u001b[38;2;211;169;255m', // 色组 hexnum #D3A9FF
  opt: '\u001b[38;2;230;179;63m', // 色组 flag #E6B33F
  ip4: '\u001b[38;2;253;156;202m', // 色组 ip #FD9CCA
  addr6: '\u001b[38;2;255;125;156m', // 色组 mac #FF7D9C
  path: '\u001b[38;2;153;229;254m', // 色组 path #99E5FE
  srcloc: '\u001b[38;2;126;230;133m', // 色组 loc #7EE685
  url: '\u001b[38;2;249;143;110m', // 色组 url #F98F6E
  port: '\u001b[38;2;156;236;185m', // 色组 port #9CECB9
  ident: '\u001b[38;2;161;195;124m', // 色组 ident #A1C37C
  artifact: '\u001b[38;2;224;173;113m', // 色组 artifact #E0AD71
  diffmark: '\u001b[38;2;191;227;93m', // 色组 diffmark #BFE35D
  action: '\u001b[38;2;39;205;146m' // 色组 action #27CD92
}
// TC 键 → COLOR_GROUPS 键（快照与唯一来源的对应关系，供同源测试逐键核对）
const TC_GROUP = {
  ts: 'time',
  dur: 'duration',
  size: 'size',
  num: 'number',
  hex: 'hexnum',
  opt: 'flag',
  ip4: 'ip',
  addr6: 'mac',
  path: 'path',
  srcloc: 'loc',
  url: 'url',
  port: 'port',
  ident: 'ident',
  artifact: 'artifact',
  diffmark: 'diffmark',
  action: 'action'
}
const presetByName = (presets, name) => presets.find(p => p.name === name)

// V2：业务组只存领域规则，共享形状在三个「通用 · *」组里；着色断言必须用
// resolvePresetKeywords 展开（含 requires 的通用档），否则拿不到 IP/时间戳等。
let _presets = null
let _groups = null
const resolve = async (name) => {
  if (!_presets) _presets = (await loadPresets()).keywordPresets
  if (!_groups) _groups = await loadGroups()
  return _groups.resolvePresetKeywords(presetByName(_presets, name))
}
// 全部预设应用后的生效规则（真实 apply 路径，顺序与 UI 一致）
const allApplied = async () => {
  if (!_presets) _presets = (await loadPresets()).keywordPresets
  if (!_groups) _groups = await loadGroups()
  const applied = _presets.reduce((acc, p) => _groups.setPresetGroupOn(acc, p, true), [])
  return _groups.activeKeywords(applied)
}
const allAddon = async () => new (await loadAddon()).KeywordHighlighterAddon(await allApplied())

describe('keyword presets', () => {
  test('every Networking rule compiles with the flags the addon uses', async () => {
    const { keywordPresets, COLOR_GROUPS } = await loadPresets()
    const groupColors = new Set(Object.values(COLOR_GROUPS).map(g => g.color))
    const preset = presetByName(keywordPresets, 'Networking')
    assert.ok(preset)
    for (const { keyword, color } of preset.keywords) {
      assert.doesNotThrow(() => new RegExp(keyword, 'gi'), keyword)
      assert.ok(colors.includes(color) || groupColors.has(color), `色板外的颜色 ${color}`)
    }
  })

  test('Networking preset colours typical switch output', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(await resolve('Networking'))
    const out = addon.highlightKeywords('Gi1/0/3   notconnect   600   26.132.128.13   0011.2233.4455')

    assert.ok(out.includes(TC.ident + 'Gi1/0/3')) // interface: 领域标识色组（同起点语义，不再借用 ANSI blue）
    assert.ok(out.includes('\u001b[31mnotconnect')) // state: red
    assert.ok(out.includes(TC.ip4 + '26.132.128.13')) // IP: pink (from 通用·地址与路径)
    assert.ok(out.includes(TC.addr6 + '0011.2233.4455')) // MAC: orchid
  })

  test('Networking preset covers other vendors and leaves plain words alone', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(await resolve('Networking'))
    const ident = TC.ident
    const interfaces = [
      'ge-0/0/0', 'irb.100', 'ae0', // Juniper
      'Et1', 'Ma1', // Arista
      '1/1/1', 'Trk1', // HPE Aruba CX, ProCurve
      'XGE1/0/1', 'Bridge-Aggregation1', // HP Comware
      'XGigabitEthernet0/0/1', '40GE1/0/1', 'Eth-Trunk1', 'Vlanif10', // Huawei
      'eth1.100', 'switch0', // Ubiquiti EdgeOS
      'ether1', 'sfp-sfpplus1' // MikroTik
    ]
    for (const name of interfaces) {
      assert.ok(addon.highlightKeywords(`port ${name} status`).includes(ident + name), name)
    }
    assert.ok(addon.highlightKeywords('eth0 u/u').includes('\u001b[32mu/u'))
    assert.ok(addon.highlightKeywords('eth1 A/D').includes('\u001b[31mA/D'))
    assert.ok(addon.highlightKeywords('GE1/0/2 ADM').includes('\u001b[31mADM'))
    const prose = 'the page 5 says ether and ge stay plain on 10/08/26'
    assert.equal(addon.highlightKeywords(prose), prose)
  })

  test('every preset is well formed + 跨组唯一', async () => {
    const { keywordPresets } = await loadPresets()
    assert.ok(keywordPresets.length > 1)

    const names = new Set()
    const globalSeen = new Map() // keyword -> first preset name（跨组唯一判据）
    for (const preset of keywordPresets) {
      assert.ok(preset.name, 'preset has a name')
      assert.ok(!names.has(preset.name), `duplicate preset name: ${preset.name}`)
      names.add(preset.name)
      assert.ok(preset.description && preset.description.length > 20, `description for ${preset.name}`)
      assert.ok(preset.keywords.length >= 3, `enough rules for ${preset.name}`)

      const seen = new Set()
      for (const { keyword, color } of preset.keywords) {
        assert.ok(keyword, `keyword in ${preset.name}`)
        assert.doesNotThrow(() => new RegExp(keyword, 'gi'), `${preset.name}: ${keyword}`)
        const valid = colors.includes(color) || /^#[0-9a-fA-F]{6}$/.test(color)
        assert.ok(valid, `${preset.name}: bad color ${color}`)
        assert.ok(!seen.has(keyword), `${preset.name}: duplicate rule ${keyword}`)
        seen.add(keyword)
        // 跨组唯一：同一条正则（同文本）全仓只在一个预设的 keywords 里出现
        const prev = globalSeen.get(keyword)
        assert.ok(
          prev === undefined || prev === preset.name,
          `pattern appears in two presets: ${prev} and ${preset.name} — ${keyword}`
        )
        if (prev === undefined) globalSeen.set(keyword, preset.name)
      }
    }
  })

  test('presets highlight representative lines and avoid JSON noise', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const out = async (name, line) => new KeywordHighlighterAddon(await resolve(name)).highlightKeywords(line)

    // 各预设的典型高亮（共享词表经 requires 拉进业务组）
    assert.ok((await out('Application log levels', '2026-10-09 ERROR boom')).includes('\u001b[31mERROR'))
    assert.ok((await out('通用 · 时间与数值', 'up since 2026-10-09T08:00:00Z')).includes(TC.ts + '2026-10-09T08:00:00Z'))
    assert.ok((await out('Exceptions & Stack Traces', 'java.lang.NullPointerException: x')).includes('\u001b[31mjava.lang.NullPointerException'))
    assert.ok((await out('Docker & Kubernetes', 'pod/web-0 CrashLoopBackOff')).includes('\u001b[31mCrashLoopBackOff'))
    assert.ok((await out('Git', '<<<<<<< HEAD')).includes('\u001b[31m<<<<<<<'))
    assert.ok((await out('Build & test output', '42 passed, 3 failed')).includes('\u001b[32mpassed'))
    assert.ok((await out('Build & test output', '42 passed, 3 failed')).includes('\u001b[31mfailed'))
    assert.ok((await out('Auth & security', 'sudo: permission denied for x')).includes('\u001b[31mpermission denied'))
    // 负例:普通 prose 不动
    const prose = 'the weather is fine today'
    assert.equal(await out('Application log levels', prose), prose)
    // JSON 噪音排除:时间戳和 errors 键名不应被高亮
    assert.equal(await out('通用 · 时间与数值', '"created_time":"2026-10-09 10:24:57",'), '"created_time":"2026-10-09 10:24:57",')
    assert.equal(await out('Networking', '"errors":0, "denied_count":0'), '"errors":0, "denied_count":0')
  })

  test('报错/告警词表对齐 WindTerm 默认 Linux 方案的 error 档', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const red = '\u001b[31m'
    const yellow = '\u001b[33m'
    const end = '\u001b[0m'
    const errorCases = [
      ['Application log levels', 'bash: foo: command not found', 'not found'],
      ['Application log levels', 'invalid option --z', 'invalid'],
      ['Application log levels', 'could not resolve host example.com', 'could not'],
      ['Build & test output', 'error: wrong type in x.c', 'wrong'],
      ['Build & test output', 'bad superblock, missing dependency', 'bad'],
      ['Build & test output', 'unexpected token, mismatched braces', 'unexpected'],
      ['Linux kernel & dmesg', 'device is unavailable', 'unavailable'],
      ['Syslog & systemd', 'unit cannot start, rescheduling', 'cannot'],
      ['Exceptions & Stack Traces', 'certificate expired for host x', 'expired']
    ]
    for (const [name, line, word] of errorCases) {
      const out = new KeywordHighlighterAddon(await resolve(name)).highlightKeywords(line)
      assert.ok(out.includes(red + word + end), `${name}: ${line} → ${word}`)
    }
    const warn = new KeywordHighlighterAddon(await resolve('Application log levels'))
      .highlightKeywords('deprecated api, feature disabled, unknown mode')
    assert.ok(warn.includes(yellow + 'deprecated' + end))
    assert.ok(warn.includes(yellow + 'disabled' + end))
    assert.ok(warn.includes(yellow + 'unknown' + end))
    // 否定式只认整词组：裸 not / no 不进红档
    const all = await allAddon()
    const noChanges = all.highlightKeywords('no changes added to commit')
    assert.ok(noChanges.includes(yellow + 'no changes added to commit' + end), noChanges)
    const ff = all.highlightKeywords('not possible to fast-forward')
    assert.ok(ff.includes(red + 'not possible to fast-forward' + end), ff)
    assert.ok(all.highlightKeywords('flag true, none left').includes('\u001b[35mtrue'))
  })

  test('通用三档复刻 WindTerm 默认层的结构档（原 Shell & command output 组）', async () => {
    const { keywordPresets } = await loadPresets()
    const { resolvePresetKeywords } = await loadGroups()
    // 通用三档承载共享形状；devAddr（PCI 地址）是内核组独有，一并纳入以覆盖原 Shell 组的断言
    const universalNames = ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径', 'Linux kernel & dmesg']
    const uRules = universalNames.flatMap(n => resolvePresetKeywords(presetByName(keywordPresets, n)))
    assert.ok(uRules.length >= 15, 'three universal groups + kernel carry the shared rules')
    const addon = new (await loadAddon()).KeywordHighlighterAddon(uRules)
    const red = '\u001b[31m'
    const green = '\u001b[32m'
    const yellow = '\u001b[33m'
    const blue = '\u001b[34m'
    const cyan = '\u001b[36m'
    const end = '\u001b[0m'

    const ls = addon.highlightKeywords('-rw-r--r-- 1 dp25 dp25 4096 Oct  9 08:57 report.pdf')
    assert.ok(ls.includes(TC.num + '4096' + end))
    assert.ok(ls.includes(TC.ts + '08:57' + end), 'the whole clock, not half of it')
    assert.equal(ls.includes(yellow), false, ls)

    const curl = addon.highlightKeywords('curl -sS --max-time=30 -o /tmp/out.json')
    assert.ok(curl.includes(TC.opt + '-sS' + end) && curl.includes(TC.opt + '--max-time=30' + end), curl)
    assert.ok(curl.includes(TC.path + '/tmp/out.json' + end), curl)
    const df = addon.highlightKeywords('df -h /dev/sda2  233G   98G  45%')
    assert.ok(df.includes(TC.size + '233G' + end) && df.includes(TC.size + '98G' + end), df)
    assert.ok(df.includes(TC.num + '45%' + end), df)
    const pci = addon.highlightKeywords('0000:3b:00.0 bridge usb 1-2')
    assert.ok(pci.includes(TC.ip4 + '0000:3b:00.0' + end), pci)
    assert.equal(pci.includes(TC.num + '00.0'), false, 'the tail of a PCI address is not a bare number')
    assert.ok(addon.highlightKeywords('lspci 00:02.0 VGA compatible').includes(TC.ip4 + '00:02.0' + end))
    assert.equal(addon.highlightKeywords('lspci 00:02.0').includes(TC.num), false)
    assert.ok(addon.highlightKeywords('0x4D7953514C').includes(TC.hex + '0x4D7953514C' + end))

    assert.ok(addon.highlightKeywords('bash: foo: command not found').includes(red + 'not found' + end))
    assert.ok(addon.highlightKeywords('bad superblock, unsupported option').includes(red + 'bad' + end))
    assert.ok(addon.highlightKeywords('permission denied, try again 1.5 s').includes(red + 'permission denied' + end))
    assert.ok(addon.highlightKeywords('make: *** [Makefile:12] Error 2').includes(red + 'Error' + end))
    assert.ok(addon.highlightKeywords('Query OK, 3 rows affected (0.01 sec)').includes(green + 'OK' + end))
    assert.ok(addon.highlightKeywords('Authentication succeeded for login dp25').includes(green + 'succeeded' + end))
    const auth = addon.highlightKeywords('access denied for user root@10.1.2.3')
    assert.equal(auth.includes(blue + 'access'), false, auth)
    // access denied 作为整句归通用红档（批次 B 从 Networking/Auth/Database 三处上收）
    assert.ok(auth.includes(red + 'access denied' + end), auth)

    assert.equal(addon.highlightKeywords('the quick brown fox jumps over the lazy dog'), 'the quick brown fox jumps over the lazy dog')
    assert.equal(addon.highlightKeywords('nginx version: nginx/1.20.1 built with OpenSSL/3.0.2'), 'nginx version: nginx/1.20.1 built with OpenSSL/3.0.2')
    assert.equal(addon.highlightKeywords('2026-11-03 report'), '2026-11-03 report')
    assert.equal(addon.highlightKeywords('"GET / HTTP/1.1" 500'), '"GET / HTTP/1.1" 500')
    const restart = addon.highlightKeywords('restarts 12 (30s ago)')
    assert.equal(restart.includes(cyan + '12'), false, restart)

    // 共享规则归位：devAddr 在内核组、hex 在 时间与数值 通用组，各只一份
    const { keywordPresets: kp } = await loadPresets()
    const kernel = presetByName(kp, 'Linux kernel & dmesg')
    const timeNum = presetByName(kp, '通用 · 时间与数值')
    const devAddr = kernel.keywords.find(k => k.keyword.includes('[0-9a-f]{4}:'))
    const hex = timeNum.keywords.find(k => k.keyword.includes('0x[0-9a-f]{2,}'))
    assert.ok(devAddr, 'devAddr lives in the kernel group now')
    assert.ok(hex, 'hex lives in the universal 时间与数值 group now')
    assert.equal(timeNum.keywords.filter(k => k.keyword.includes('0x[0-9a-f]')).length, 1)
  })

  test('结构档并进其他组后不改变既有预设的结论', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const all = await allAddon()
    const red = '\u001b[31m'
    const green = '\u001b[32m'
    const end = '\u001b[0m'

    assert.ok(all.highlightKeywords('"GET / HTTP/1.1" 500 1').includes(red + '500' + end))
    assert.ok(all.highlightKeywords('"GET / HTTP/1.1" 200 1').includes(green + '200' + end))
    const req = all.highlightKeywords('request_time=0.012 upstream_response_time=0.008 status=404')
    assert.ok(req.includes(TC.dur + 'request_time=0.012' + end), req)
    assert.ok(req.includes('\u001b[33mstatus=404' + end), req)
    assert.ok(all.highlightKeywords('size 220 MB/s, 0.01 sec, 12 minutes').includes(TC.size + '220 MB/s' + end))
    assert.ok(all.highlightKeywords('took 1.5 s').includes(TC.dur + 'took 1.5 s' + end))
    assert.ok(all.highlightKeywords('lspci 00:02.0 VGA').includes(TC.ip4 + '00:02.0' + end))
    assert.ok(all.highlightKeywords('Oct  9 08:57 report').includes(TC.ts + '08:57' + end))
    for (const name of ['Docker & Kubernetes', '通用 · 级别与状态']) {
      assert.ok(new KeywordHighlighterAddon(await resolve(name))
        .highlightKeywords('Job my-job Completed Succeeded').includes(green + 'Completed' + end), name)
    }
    assert.ok(new KeywordHighlighterAddon(await resolve('Linux kernel & dmesg'))
      .highlightKeywords('pci 0000:3b:00.0').includes(TC.ip4 + '0000:3b:00.0' + end))
  })

  test('同一行在终端与数据库网格拿到完全一致的着色（两端共用 keyword-scan）', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { compileKeywords } = await import('../../client/common/keyword-compile.js')
    const { buildScan, collectMatches, applyCoverageGate } = await import('../../client/common/keyword-scan.js')
    // V2 批次 0：扫描裁决同源后，终端与网格都调 common/keyword-scan.js 的同一套实现。
    // 批次 3 的覆盖率闸同样两端同源；本用例是「同跨度」契约断言，两端都关闸。
    const rules = await allApplied()
    const compiled = compileKeywords(rules)

    const fs = require('node:fs')
    const path = require('node:path')
    const vm = require('node:vm')
    const SRC = path.join(__dirname, '../../client/components/database/db-highlight.jsx')
    const src = fs.readFileSync(SRC, 'utf8')
    const m = src.match(/export function highlightValue \([\s\S]*?\n\}/)
    let body = m[0].replace(/^export /, '')
    const jsx = body.match(/<span[\s\S]*?<\/span>/)
    body = body.replace(jsx[0],
      "React.createElement('span', { key: h.start, className: 'db-kw', style: (themeConfig && themeConfig[h.color] ? { color: themeConfig[h.color] } : undefined), __start: h.start, __end: h.end, __color: h.color }, text.slice(h.start, h.end))")
    const gridSpans = []
    const sandbox = {
      maxHighlightLength: 4096,
      maxHits: 200,
      buildScan,
      collectMatches,
      applyCoverageGate,
      React: { createElement: (type, props) => { if (type === 'span') gridSpans.push({ start: props.__start, end: props.__end, color: props.__color }); return { type, props } } }
    }
    vm.runInNewContext(body, sandbox)
    const gridHighlight = sandbox.highlightValue
    const gridOpts = { coverageGate: false }

    const ansiToColor = { 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white' }
    const rgbToHex = (code) => {
      // '38;2;r;g;b' → '#rrggbb'（预设里用大写，这里也大写以便与规则里的 color 字段一致）
      const [, , r, g, b] = code.split(';')
      const h = n => Number(n).toString(16).toUpperCase().padStart(2, '0')
      return '#' + h(r) + h(g) + h(b)
    }
    const parseTerminal = (out) => {
      const spans = []
      let i = 0; let color = null; let start = -1; let plain = 0
      while (i < out.length) {
        if (out[i] === '\u001b' && out[i + 1] === '[') {
          const end = out.indexOf('m', i)
          const code = out.slice(i + 2, end)
          if (code === '0') { if (color !== null && start >= 0) spans.push({ start, end: plain, color }); color = null; start = -1 } else if (/^3[0-7]$/.test(code)) { if (color !== null && start >= 0) spans.push({ start, end: plain, color }); color = ansiToColor[code]; start = plain } else if (/^38;2;\d+;\d+;\d+$/.test(code)) { if (color !== null && start >= 0) spans.push({ start, end: plain, color }); color = rgbToHex(code); start = plain }
          i = end + 1; continue
        }
        i++; plain++
      }
      return spans
    }

    const addon = new KeywordHighlighterAddon(rules)
    const theme = {}
    const lines = [
      'drwxr-xr-x 2 root root 4096 Oct  9 08:57 nginx.service',
      'Oct  9 08:57:36 host systemd[1]: nginx.service: Failed with result exit-code',
      'a1b2c3d4e5f6   web-0     Up 3 hours          0.0.0.0:8080->80/tcp',
      'tcp   LISTEN 0  4096  0.0.0.0:22   0.0.0.0:*   sshd',
      'tcp  ESTAB  0  0  10.1.2.3:443  93.184.216.34:80  elapsed 1.2s',
      'ERROR 1146 (42S02): Table users does not exist',
      'df -h /dev/sda2  233G   98G  45%',
      'curl -sS --max-time=30 -o /tmp/out.json',
      'root:x:0:0:root:/root:/bin/bash',
      '"GET /api/x HTTP/1.1" 500 1234 request_time=0.012',
      '404 /favicon.ico',
      'ip addr show dev eth0: inet 10.1.2.3/24 scope global eth0',
      'lspci 0000:3b:00.0 VGA compatible controller'
    ]
    for (const line of lines) {
      const termSpans = parseTerminal(addon.highlightKeywords(line))
      gridSpans.length = 0
      gridHighlight(line, compiled, theme, gridOpts)
      const gSpans = gridSpans.map(s => ({ start: s.start, end: s.end, color: s.color }))
      assert.deepEqual(termSpans, gSpans, `terminal vs grid mismatch: ${line}`)
    }

    const end = '\u001b[0m'
    const red = '\u001b[31m'
    const green = '\u001b[32m'
    assert.ok(addon.highlightKeywords('nginx.service').includes(TC.ident + 'nginx.service' + end))
    assert.equal(addon.highlightKeywords('nginx.service').includes(TC.ident + 'nginx' + end), false,
      'unit 名必须整段染色，不能只染 nginx')
    // KU-3（批次 C）：一段染色只承载一个家族。地址与端口相邻两段、各色各色，
    // 同一个 IPv4 在 `10.1.2.3` / `10.1.2.3:443` / `10.1.2.3/24` 里必须是同一个颜色。
    const hp = addon.highlightKeywords('10.1.2.3:443')
    assert.ok(hp.includes(TC.ip4 + '10.1.2.3' + end), hp)
    assert.ok(hp.includes(TC.port + ':443' + end), hp)
    assert.equal(hp.includes(TC.port + '10.1.2.3:443'), false, hp)
    assert.ok(addon.highlightKeywords('ping 10.1.2.3 ok').includes(TC.ip4 + '10.1.2.3' + end))
    assert.ok(addon.highlightKeywords('404 /favicon.ico').includes(TC.path + '/favicon.ico' + end))
    assert.ok(addon.highlightKeywords('open /tmp/out.json').includes(TC.path + '/tmp/out.json' + end))
    assert.ok(addon.highlightKeywords('Table users does not exist').includes(red + 'does not exist' + end))
    assert.ok(addon.highlightKeywords('web-0  Up 3 hours').includes(green + 'Up 3 hours' + end))
    assert.ok(addon.highlightKeywords('Gi1/0/3  up  600').includes(green + 'up' + end))
  })

  test('applying a preset keeps custom rules and skips duplicates', async () => {
    const { keywordPresets, mergeKeywordPreset } = await loadPresets()
    const preset = keywordPresets[0]
    const existing = [{ color: 'red' }, { keyword: 'mine', color: 'white' }, { ...preset.keywords[0] }]
    const merged = mergeKeywordPreset(existing, preset)

    assert.equal(merged[0].keyword, 'mine')
    assert.equal(merged.length, 1 + preset.keywords.length)
    assert.equal(mergeKeywordPreset(merged, preset).length, merged.length)
  })

  test('presets that share a rule only add it once (via requires)', async () => {
    const { keywordPresets } = await loadPresets()
    const { resolvePresetKeywords, activeKeywords } = await loadGroups()
    const names = ['Networking', 'Docker & Kubernetes', 'HTTP & web logs', 'Auth & security']
    const resolved = names.flatMap(n => resolvePresetKeywords(presetByName(keywordPresets, n)))
    const active = activeKeywords(resolved)

    assert.equal(new Set(active.map(r => r.keyword)).size, active.length)
    // ipv4 是通用·地址与路径 的规则，被多个业务组经 requires 复用，生效侧只一份
    const ipv4 = presetByName(keywordPresets, '通用 · 地址与路径').keywords.find(k => k.keyword.includes('25[0-5]'))
    assert.ok(ipv4, '通用·地址与路径 carries the IPv4 rule')
    assert.equal(active.filter(r => r.keyword === ipv4.keyword).length, 1)
    for (const name of names) {
      assert.ok(resolvePresetKeywords(presetByName(keywordPresets, name)).some(k => k.keyword === ipv4.keyword), `${name} pulls in IPv4 via requires`)
    }
  })

  test('merged rules keep whole phrases intact', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = async (n) => new KeywordHighlighterAddon(await resolve(n))
    const red = '\u001b[31m'
    const end = '\u001b[0m'

    assert.ok((await addon('Exceptions & Stack Traces'))
      .highlightKeywords('Traceback (most recent call last):').includes(red + 'Traceback (most recent call last)' + end))
    assert.ok((await addon('Docker & Kubernetes')).highlightKeywords('Exited (137) 2 minutes ago').includes(red + 'Exited (137)' + end))
    assert.ok((await addon('Docker & Kubernetes')).highlightKeywords('Exited (0) 3 minutes ago').includes('\u001b[32mExited (0)' + end))
    assert.ok((await addon('通用 · 时间与数值')).highlightKeywords('[00:12:34.567] worker').includes(TC.ts + '[00:12:34.567]' + end))
    assert.ok((await addon('HTTP & web logs'))
      .highlightKeywords('[Wed Oct 09 08:57:36.123456 2026]').includes(TC.ts + 'Oct 09 08:57:36.123456' + end))
    assert.ok((await addon('HTTP & web logs')).highlightKeywords('[core:error] boom').includes(red + '[core:error]' + end))
    assert.ok((await addon('HTTP & web logs')).highlightKeywords('[ssl:warn] cert').includes('\u001b[33m[ssl:warn]' + end))
    const both = (await addon('HTTP & web logs'))
      .highlightKeywords('request_time=0.012 upstream_response_time=0.008')
    assert.ok(both.includes(TC.dur + 'request_time=0.012\u001b[0m'), 'unit tail must not eat the next key')
    assert.ok(both.includes(TC.dur + 'upstream_response_time=0.008\u001b[0m'))
    assert.ok((await addon('Networking')).highlightKeywords('address 10.1.2.3/24 masked').includes(TC.ip4 + '10.1.2.3/24\u001b[0m'),
      'CIDR 整段属于 ipv4 家族，不再被接口名规则分走')
  })

  test('Syslog preset colours severity and unit lifecycle', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(await resolve('Syslog & systemd'))
    const out = addon.highlightKeywords('Oct  9 08:57:36 host systemd[1]: nginx.service: Failed with result exit-code')

    assert.ok(out.includes('\u001b[31mFailed'))
    assert.ok(out.includes(TC.ident + 'nginx.service'))
    assert.ok(addon.highlightKeywords('Started nginx.service.').includes('\u001b[32mStarted'))
  })

  test('HTTP preset colours status codes by class', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(await resolve('HTTP & web logs'))

    assert.ok(addon.highlightKeywords('"GET / HTTP/1.1" 500 1').includes('\u001b[31m500'))
    assert.ok(addon.highlightKeywords('"GET / HTTP/1.1" 404 1').includes('\u001b[33m404'))
    assert.ok(addon.highlightKeywords('"GET / HTTP/1.1" 200 1').includes('\u001b[32m200'))
    // 裸三位数字现在归属「时间与数值」通用档的 num 规则（结构档），HTTP 组内即生效；
    // 仅当处于请求行引号后（status 规则）才被染成状态码色。
    assert.ok(addon.highlightKeywords('the 500 page').includes(TC.num + '500'))
  })

  test('Docker preset keeps pod names whole and colours port mappings', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(await resolve('Docker & Kubernetes'))
    const end = '\u001b[0m'
    const out = addon.highlightKeywords('nginx-7d9f8c6b5-x2k4p   0/1   CrashLoopBackOff   12 (30s ago)   5m')

    assert.ok(out.includes(TC.artifact + 'nginx-7d9f8c6b5-x2k4p'))
    assert.ok(out.includes('\u001b[31mCrashLoopBackOff'))
    assert.ok(out.includes(TC.port + '12 (30s ago)'))
    // 批次 C：地址与端口分段染色；时长（AGE 列 5m / 12m30s）由通用 duration 族认领
    const listen = addon.highlightKeywords('0.0.0.0:8080->80/tcp')
    assert.ok(listen.includes(TC.ip4 + '0.0.0.0' + end), listen)
    assert.ok(listen.includes(TC.port + ':8080->80/tcp' + end), listen)
    assert.ok(addon.highlightKeywords('redis  12m30s').includes(TC.dur + '12m30s' + end))
  })

  test('Git preset colours conflicts and leaves the status letters alone', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(await resolve('Git'))
    const conflict = addon.highlightKeywords('CONFLICT (content): Merge conflict in src/x.js')

    assert.ok(conflict.includes('\u001b[31mCONFLICT'))
    assert.ok(conflict.includes(TC.path + 'src/x.js'))
    assert.equal(addon.highlightKeywords(' M src/x.js'), ' M ' + TC.path + 'src/x.js' + '\u001b[0m')
  })

  test('Database preset colours SQL, NULL, errors and client status lines', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(await resolve('Database & SQL'))

    const sql = addon.highlightKeywords('SELECT id FROM users WHERE name IS NULL')
    assert.ok(sql.includes(TC.ident + 'SELECT'))
    assert.ok(sql.includes(TC.ident + 'FROM'))
    assert.ok(sql.includes(TC.ident + 'WHERE'))
    assert.ok(sql.includes('\u001b[35mNULL'))

    assert.ok(addon.highlightKeywords('SELECT `db`.`t`').includes(TC.ident + '`db`'))
    assert.ok(addon.highlightKeywords('SELECT "public"."users"').includes(TC.ident + '"public"."users"'))

    const err = addon.highlightKeywords('ERROR 1146 (42S02): Table users does not exist')
    assert.ok(err.includes('\u001b[31mERROR'))
    assert.ok(err.includes('\u001b[31mdoes not exist'))
    assert.ok(addon.highlightKeywords("(error) ERR unknown command 'foo'").includes('\u001b[31m(error)'))

    const status = addon.highlightKeywords('Query OK, 3 rows affected (0.01 sec)')
    assert.ok(status.includes('\u001b[32mQuery OK'))
    assert.ok(status.includes('\u001b[32mrows affected'))
    // 耗时属于 duration 家族，家族色 = 真彩色 teal（V3 KU-6：结构档不再占用 ANSI cyan）
    assert.ok(status.includes(TC.dur + '(0.01 sec)'))
    assert.ok(addon.highlightKeywords('(integer) 42').includes(TC.num + '(integer)'))
    assert.ok(addon.highlightKeywords('(3 rows)').includes('\u001b[32m(3 rows)'))

    assert.ok(addon.highlightKeywords('2026-10-14 19:22:31').includes(TC.ts + '2026-10-14'))
    assert.ok(addon.highlightKeywords('550e8400-e29b-41d4-a716-446655440000').includes(TC.artifact + '550e8400'))
    assert.ok(addon.highlightKeywords('0x4D7953514C').includes(TC.hex + '0x4D7953514C'))

    const prose = 'the quick brown fox jumps over the lazy dog'
    assert.equal(addon.highlightKeywords(prose), prose)
  })

  test('Batch 2 中等收口：生效规则数介于 v1 基线 105 与硬上限 60 之间', async () => {
    // 中等收口只删「与通用档语义重复的通用报错/成功/警告词表」，保留全部领域名词；
    // 密度由 Batch 3 覆盖率闸 + structure 默认不进全选治理，不激进砍到 ≤60。
    const all = await allApplied()
    assert.ok(all.length < 105, `effective ${all.length} should be below v1 baseline 105`)
    assert.ok(all.length > 60, `effective ${all.length} keeps domain coverage (moderate, not aggressive ≤60)`)
    // 顺带确认：通用档仍是共享形状的唯一存放处（跨组唯一 + 共享只一份）
    const { keywordPresets } = await loadPresets()
    const { resolvePresetKeywords } = await loadGroups()
    const byName = (n) => keywordPresets.find(p => p.name === n)
    const universal = ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径']
      .flatMap(n => resolvePresetKeywords(byName(n)))
    const seen = new Set()
    for (const r of universal) {
      const key = r.keyword + '\u0000' + (r.color || 'red')
      assert.ok(!seen.has(key), `universal rule duplicated within universal groups: ${r.keyword}`)
      seen.add(key)
    }
  })

  test('Batch 4 真彩色：#rrggbb 编译为真彩色序列，命名色不变，扩展调色板可达', async () => {
    const { compileKeywords, hexToTruecolor, isHexColor, keywordPalette } = await import('../../client/common/keyword-compile.js')
    const { colorToCode } = await import('../../client/common/keyword-compile.js')
    // 用与色板无关的样例 hex，避免把某个具体色值读成"色板里的颜色"
    assert.equal(hexToTruecolor('#123456'), '\u001b[38;2;18;52;86m')
    assert.equal(isHexColor('#123456'), true)
    assert.equal(isHexColor('cyan'), false)
    const c = compileKeywords([{ keyword: '\\d+', color: '#123456' }])
    assert.equal(c[0].colorCode, '\u001b[38;2;18;52;86m')
    const named = compileKeywords([{ keyword: '\\d+', color: 'red' }])
    assert.equal(named[0].colorCode, '\u001b[31m')
    // 命名色 + 结构真彩色都在取色器里；真彩色条目由 COLOR_GROUPS 派生，不是第二份表
    const { COLOR_GROUPS } = await loadPresets()
    const values = keywordPalette.map(p => p.value)
    const structureHexes = Object.values(COLOR_GROUPS).filter(d => /^#/.test(d.color)).map(d => d.color)
    assert.ok(values.includes('red'))
    assert.equal(values.filter(v => /^#/.test(v)).length, structureHexes.length)
    assert.ok(structureHexes.every(h => values.includes(h)), '取色器与色板不同源')
    // 样例 hex 全部与色板无关，避免把某个具体色值读成"色板里的颜色"
    assert.equal(colorToCode('#00FF88'), '\u001b[38;2;0;255;136m')
  })

  // 色板只有一个来源，本文件顶部的 TC 是它的字面快照。快照过期时会伪装成"某条正则
  // 没染色"，所以先核对快照本身。重生成（按 TC_GROUP 把色组名对回键名）：
  //   node --experimental-detect-module --input-type=module -e \
  //     "Promise.all([import('./src/client/common/keyword-presets.js'),import('./src/client/common/keyword-compile.js')])" \
  //     ".then(([p,c])=>console.log(Object.entries(p.COLOR_GROUPS).filter(([,d])=>/^#/.test(d.color))" \
  //     ".map(([g,d])=>g+' '+c.hexToTruecolor(d.color).replace(/\u001b/,'\\\\u001b')).join('\n')))"
  test('TC 快照与 COLOR_GROUPS 同源：色板换色后先在这里报错', async () => {
    const { COLOR_GROUPS } = await loadPresets()
    const { hexToTruecolor } = await import('../../client/common/keyword-compile.js')
    const stale = Object.entries(TC_GROUP)
      .filter(([key, group]) => TC[key] !== hexToTruecolor(COLOR_GROUPS[group].color))
      .map(([key, group]) => `${key}（色组 ${group} 现在是 ${COLOR_GROUPS[group].color}）`)
    assert.deepEqual(stale, [], 'TC 快照与色板不同源，按上面命令重新生成后再跑')
  })

  test('V1 CDP demo 口径已更新为 V2（轻量源码契约，不引入 CDP 依赖）', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const root = path.join(__dirname, '../../..')
    const demo = fs.readFileSync(path.join(root, 'self-test/kw-preset-merge-demo.js'), 'utf8')
    const locales = fs.readFileSync(path.join(root, 'src/app/common/locales-extra.js'), 'utf8')
    for (const stale of ['155', '13 个分组', '107', '145', '136', '0/155', '10 条静音']) {
      assert.ok(!demo.includes(stale), `旧口径数字「${stale}」不应再出现在 CDP demo`)
    }
    assert.match(demo, /口径已更新为 V2，但仍需实机 CDP 验证/)
    assert.match(demo, /loadV2Baseline/, '期望值必须从真实数据源现算')
    assert.match(demo, /keyword-density-demo\.js/)
    assert.match(demo, /keyword-density\.spec\.js/)
    for (const key of ['kwApplySemantic', 'kwUnapplyAll', 'kwStructureTier']) {
      assert.ok(new RegExp('\\b' + key + '\\s*:').test(locales), `${key} 必须存在于 locales-extra.js`)
      assert.ok(demo.includes(key), `CDP demo 仍应使用 ${key}`)
    }
    assert.match(demo, /'Networking'/, '组级取消必须用 V2 里真实存在的组名')
  })
})
