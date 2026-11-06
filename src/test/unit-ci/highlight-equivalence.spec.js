const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// 本文件验证「单遍扫描引擎 == 逐规则参考引擎」逐字节一致。参考引擎不含密度策略，
// 故这里统一关掉 V2 批次 3 的行级覆盖率闸；闸的语义由 keyword-density.spec.js 验收。
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
const loadCompile = () => import('../../client/common/keyword-compile.js')

// 旧引擎的参考实现：逐规则把整段扫一遍、收集全部命中，再按 V3 家族裁决口径
// 「起点升序 → rank 升序 → 同 rank 跨度降序，等长交给原序（sort 稳定 == index 升序）」
// 排序并跳过重叠。新引擎（单大正则单遍扫描）必须与它逐字节一致。
function referenceHighlight (text, patterns, maxMatches) {
  // eslint-disable-next-line no-control-regex
  const ansiPattern = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[\??[0-9;]*[A-Za-z]/g
  const segments = []
  let last = 0
  let match
  ansiPattern.lastIndex = 0
  while ((match = ansiPattern.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: 'text', content: text.slice(last, match.index) })
    segments.push({ type: 'ansi', content: match[0] })
    last = ansiPattern.lastIndex
  }
  if (last < text.length) segments.push({ type: 'text', content: text.slice(last) })
  const out = segments.map(seg => {
    if (seg.type === 'ansi') return seg.content
    const content = seg.content
    const matches = []
    for (const { re, colorCode, rank } of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(content)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue }
        matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], colorCode, rank })
        if (matches.length >= maxMatches) break
      }
      if (matches.length >= maxMatches) break
    }
    if (matches.length === 0) return content
    matches.sort((a, b) => a.start - b.start || (a.rank || 50) - (b.rank || 50) || b.end - a.end)
    const filtered = [matches[0]]
    for (let i = 1; i < matches.length; i++) {
      if (matches[i].start >= filtered[filtered.length - 1].end) filtered.push(matches[i])
    }
    let s = ''
    let pos = 0
    for (const m of filtered) {
      s += content.slice(pos, m.start)
      s += m.colorCode + m.text + '\u001b[0m'
      pos = m.end
    }
    s += content.slice(pos)
    return s
  }).join('')
  return out
}

// 代表性混合语料：把各预设的典型行、边界值、散文、JSON 都掺在一起
const corpus = [
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
  'lspci 0000:3b:00.0 VGA compatible controller',
  'SELECT id FROM users WHERE name IS NULL',
  'Query OK, 3 rows affected (0.01 sec)',
  'nginx-7d9f8c6b5-x2k4p   0/1   CrashLoopBackOff   12 (30s ago)   5m',
  'bash: foo: command not found',
  'sudo: permission denied for root@10.1.2.3',
  'CONFLICT (content): Merge conflict in src/x.js',
  '[core:error] [client 10.1.2.3] failed to connect',
  'python3 setup.py install: Traceback (most recent call last):',
  'java.lang.NullPointerException: null at com.Example.run(Example.java:12)',
  '2026-10-09T08:00:00Z request_time=0.012 upstream_response_time=0.008 status=404',
  'GET https://example.com/api HTTP/1.1 200 OK Mozilla/5.0 (X11; Linux)',
  'pid=1234  port 443  port 8080  cpu0  ata3  nvme0n1p2  550e8400-e29b-41d4-a716-446655440000',
  'the quick brown fox jumps over the lazy dog',
  'the 500 page and 200 items and 404 reasons',
  'nginx version: nginx/1.20.1 built with OpenSSL/3.0.2',
  '{"errors":0,"denied_count":0,"ok":true,"created_time":"2026-10-09 10:24:57"}',
  'make: *** [Makefile:12] Error 2',
  '42 passed, 3 failed, 1 skipped in 0.45s',
  'M  src/a.js\nA  src/b.js\n?? src/c.js',
  'Starting nginx.service... Started nginx.service.',
  'Sep 12 03:14:15 host kernel: [   12.345678] sd 0:0:0:0: [sda] Attached SCSI disk',
  'warning: deprecated API, feature disabled, unknown mode, invalid option',
  'TLSv1.3 handshake verify returned ok Cipher is TLS_AES_256_GCM_SHA384',
  'eth0 u/u   eth1 A/D   GE1/0/2 ADM   port 10/1/1 status down',
  'HOST: 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ONLINE'
]

const subsets = async () => {
  const { keywordPresets } = await loadPresets()
  const { activeKeywords, setPresetGroupOn } = await loadGroups()
  const byName = n => keywordPresets.find(p => p.name === n)
  // 走应用真实路径：把预设逐个点亮（展开 requires），再取生效规则。
  // 这样既验证了单遍引擎与逐规则引擎等价，也隐含验证了 requires 展开后规则集正确。
  const build = (label, presets) => {
    let list = []
    for (const p of presets) {
      if (!p) continue
      list = setPresetGroupOn(list, p, true)
    }
    return { label, rules: activeKeywords(list) }
  }
  const out = []
  // 全量、每个单组、Shell+日志混合、以及若干两两组合
  out.push(build('全量', keywordPresets))
  for (const p of keywordPresets) out.push(build(p.name, [p]))
  out.push(build('Shell+应用日志', [byName('通用 · 时间与数值'), byName('Application log levels')]))
  out.push(build('Networking+Docker', [byName('Networking'), byName('Docker & Kubernetes')]))
  out.push(build('HTTP+DB', [byName('HTTP & web logs'), byName('Database & SQL')]))
  out.push(build('Git+Build', [byName('Git'), byName('Build & test output')]))
  out.push(build('Auth+Kernel', [byName('Auth & security'), byName('Linux kernel & dmesg')]))
  return out
}

describe('single-regex engine is equivalent to per-rule scanning', () => {
  test('preset rule sets produce byte-identical output to the reference engine', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    for (const { label, rules } of await subsets()) {
      const addon = new KeywordHighlighterAddon(rules)
      const compiled = addon.compiledPatterns
      for (const line of corpus) {
        const got = addon.highlightKeywords(line)
        const want = referenceHighlight(line, compiled, addon.maxMatchesPerSegment)
        assert.equal(got, want, `${label} :: ${line}`)
      }
    }
  })

  test('multi-line chunks and ANSI-bearing writes stay identical', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { keywordPresets } = await loadPresets()
    const { activeKeywords } = await loadGroups()
    const { clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    const rules = activeKeywords(keywordPresets.reduce((acc, p) => acc.concat(p.keywords), []))
    const addon = new KeywordHighlighterAddon(rules)
    const compiled = addon.compiledPatterns
    // 合并成一大段（> maxHighlightLength）走逐行分支；夹带 ANSI 颜色与 OSC 序列
    const bundle = corpus.join('\r\n') +
      '\r\n\u001b[32mREADY\u001b[0m 10.1.2.3 up\r\n\u001b]0;title\u0007done'
    const got = addon.highlightChunk(bundle)
    // 参考：逐行（按 \n 切，保持 \r）走参考实现后再拼回
    const want = bundle.split('\n').map(line => {
      return line.length > addon.maxHighlightLength ? line : referenceHighlight(line, compiled, addon.maxMatchesPerSegment)
    }).join('\n')
    // highlightChunk 只在整段 <= maxHighlightLength 时整体跑 highlightKeywords；
    // 这里整段超长会走逐行分支，结果应与参考逐行一致
    assert.equal(got, want)
  })

  test('the combined regex is actually used, not the per-rule fallback', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { keywordPresets } = await loadPresets()
    const { clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    const addon = new KeywordHighlighterAddon(keywordPresets[0].keywords)
    assert.ok(addon._scan, 'combined scan struct is built')
    assert.ok(addon._scan.combined instanceof RegExp)
    // 锚定裁决用的 sticky 副本与规则一一对应，且保留源的大小写不敏感标志
    assert.equal(addon._scan.sticky.length, addon.compiledPatterns.length)
    for (const re of addon._scan.sticky) {
      assert.equal(re.flags, 'giy')
    }
  })

  test('a rule with its own nested groups still resolves to the right colour', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    // ipv4 源自带 4 个捕获组；确认外层分组下标没有与分支号错位
    const addon = new KeywordHighlighterAddon([
      { keyword: '\\b(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}\\b', color: 'cyan' },
      { keyword: '\\bERROR\\b', color: 'red' }
    ])
    assert.ok(addon.highlightKeywords('ping 10.1.2.3 ok').includes('\u001b[36m10.1.2.3\u001b[0m'))
    assert.ok(addon.highlightKeywords('ERROR here').includes('\u001b[31mERROR\u001b[0m'))
  })
})
