const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadAddon = () => import('../../client/components/terminal/highlight-addon.js')
const loadPresets = () => import('../../client/common/keyword-presets.js')

const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const presetByName = (presets, name) => presets.find(p => p.name === name)

describe('keyword presets', () => {
  test('every Networking rule compiles with the flags the addon uses', async () => {
    const { keywordPresets } = await loadPresets()
    const preset = presetByName(keywordPresets, 'Networking')
    assert.ok(preset)
    for (const { keyword, color } of preset.keywords) {
      assert.doesNotThrow(() => new RegExp(keyword, 'gi'), keyword)
      assert.ok(colors.includes(color))
    }
  })

  test('Networking preset colours typical switch output', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(presetByName(keywordPresets, 'Networking').keywords)
    const out = addon.highlightKeywords('Gi1/0/3   notconnect   600   26.132.128.13   0011.2233.4455')

    assert.ok(out.includes('\u001b[34mGi1/0/3')) // interface: blue
    assert.ok(out.includes('\u001b[31mnotconnect')) // state: red
    assert.ok(out.includes('\u001b[36m26.132.128.13')) // IP: cyan
    assert.ok(out.includes('\u001b[35m0011.2233.4455')) // MAC: magenta
  })

  test('Networking preset covers other vendors and leaves plain words alone', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(presetByName(keywordPresets, 'Networking').keywords)
    const blue = '\u001b[34m'
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
      assert.ok(addon.highlightKeywords(`port ${name} status`).includes(blue + name), name)
    }
    // EdgeOS state flags and Comware admin down
    assert.ok(addon.highlightKeywords('eth0 u/u').includes('\u001b[32mu/u'))
    assert.ok(addon.highlightKeywords('eth1 A/D').includes('\u001b[31mA/D'))
    assert.ok(addon.highlightKeywords('GE1/0/2 ADM').includes('\u001b[31mADM'))
    const prose = 'the page 5 says ether and ge stay plain on 10/08/26'
    assert.equal(addon.highlightKeywords(prose), prose)
  })

  test('every preset is well formed', async () => {
    const { keywordPresets } = await loadPresets()
    assert.ok(keywordPresets.length > 1)

    const names = new Set()
    // 同一条正则在不同预设里必须是同一种配色：应用时按「正则字符串」去重，
    // 同正则不同色会静默丢掉后应用的那个预设的规则，「已应用 N 条」也会算错
    const colorOfPattern = new Map()
    for (const preset of keywordPresets) {
      assert.ok(preset.name, 'preset has a name')
      assert.ok(!names.has(preset.name), `duplicate preset name: ${preset.name}`)
      names.add(preset.name)
      assert.ok(preset.description && preset.description.length > 20, `description for ${preset.name}`)
      // 合并后同一条共享片段会被多个预设引用，单预设最低只有 3 条（Timestamps）
      assert.ok(preset.keywords.length >= 3, `enough rules for ${preset.name}`)

      const seen = new Set()
      for (const { keyword, color } of preset.keywords) {
        assert.ok(keyword, `keyword in ${preset.name}`)
        assert.doesNotThrow(() => new RegExp(keyword, 'gi'), `${preset.name}: ${keyword}`)
        assert.ok(colors.includes(color), `${preset.name}: bad color ${color}`)
        assert.ok(!seen.has(keyword), `${preset.name}: duplicate rule ${keyword}`)
        seen.add(keyword)
        const prev = colorOfPattern.get(keyword)
        assert.ok(
          prev === undefined || prev === color,
          `pattern used with two colors: ${prev} and ${color} (${preset.name}) — ${keyword}`
        )
        if (prev === undefined) colorOfPattern.set(keyword, color)
      }
    }
  })

  test('presets highlight representative lines and avoid JSON noise', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const byName = n => keywordPresets.find(p => p.name === n)
    const out = (name, line) => new KeywordHighlighterAddon(byName(name).keywords).highlightKeywords(line)

    // 各预设的典型高亮
    assert.ok(out('Application log levels', '2026-10-09 ERROR boom').includes('\u001b[31mERROR'))
    assert.ok(out('Timestamps', 'up since 2026-10-09T08:00:00Z').includes('\u001b[36m2026-10-09T08:00:00Z'))
    assert.ok(out('Exceptions & Stack Traces', 'java.lang.NullPointerException: x').includes('\u001b[31mjava.lang.NullPointerException'))
    assert.ok(out('Docker & Kubernetes', 'pod/web-0 CrashLoopBackOff').includes('\u001b[31mCrashLoopBackOff'))
    assert.ok(out('Git', '<<<<<<< HEAD').includes('\u001b[31m<<<<<<<'))
    assert.ok(out('Build & test output', '42 passed, 3 failed').includes('\u001b[32mpassed'))
    assert.ok(out('Build & test output', '42 passed, 3 failed').includes('\u001b[31mfailed'))
    assert.ok(out('Auth & security', 'sudo: permission denied for x').includes('\u001b[31mpermission denied'))
    // 负例:普通 prose 不动
    const prose = 'the weather is fine today'
    assert.equal(out('Application log levels', prose), prose)
    // JSON 噪音排除:时间戳和 errors 键名不应被高亮
    assert.equal(out('Timestamps', '"created_time":"2026-10-09 10:24:57",'), '"created_time":"2026-10-09 10:24:57",')
    assert.equal(out('Networking', '"errors":0, "denied_count":0'), '"errors":0, "denied_count":0')
  })

  test('报错/告警词表对齐 WindTerm 默认 Linux 方案的 error 档', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const red = '\u001b[31m'
    const yellow = '\u001b[33m'
    const end = '\u001b[0m'
    // WindTerm 的 token.error-token 认这些失败词，之前只有网络预设的私有词表认
    // 其中一部分；现在共享的 lvlError 一条打尽，五个引用它的预设同时生效
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
      const out = new KeywordHighlighterAddon(presetByName(keywordPresets, name).keywords)
        .highlightKeywords(line)
      assert.ok(out.includes(red + word + end), `${name}: ${line} → ${word}`)
    }
    // WindTerm 放在 error 档、本文件按自己的口径留黄档的三个词
    const warn = new KeywordHighlighterAddon(presetByName(keywordPresets, 'Application log levels').keywords)
      .highlightKeywords('deprecated api, feature disabled, unknown mode')
    assert.ok(warn.includes(yellow + 'deprecated' + end))
    assert.ok(warn.includes(yellow + 'disabled' + end))
    assert.ok(warn.includes(yellow + 'unknown' + end))
    // 否定式只认整词组：裸 not / no 不进红档，否则红档的「no <词>」会在同一位置上
    // 比 Git 预设的整句更短而抢先命中（终端的重叠裁决是同起点取更短）
    const all = new KeywordHighlighterAddon(
      keywordPresets.reduce((acc, p) => acc.concat(p.keywords), [])
    )
    const noChanges = all.highlightKeywords('no changes added to commit')
    assert.ok(noChanges.includes(yellow + 'no changes added to commit' + end), noChanges)
    const ff = all.highlightKeywords('not possible to fast-forward')
    assert.ok(ff.includes(red + 'not possible to fast-forward' + end), ff)
    // true/false/none 保持 magenta（nullBool），不跟 WindTerm 的绿/红
    assert.ok(all.highlightKeywords('flag true, none left').includes('\u001b[35mtrue'))
  })

  test('Shell & command output 组复刻 WindTerm 默认层的结构档', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const shell = presetByName(keywordPresets, 'Shell & command output')
    assert.ok(shell, 'shell preset is present')
    // 排在第一位：「只想让终端像 WindTerm」时不需要往下翻
    assert.equal(keywordPresets[0].name, 'Shell & command output')
    const addon = new KeywordHighlighterAddon(shell.keywords)
    const red = '\u001b[31m'
    const green = '\u001b[32m'
    const yellow = '\u001b[33m'
    const blue = '\u001b[34m'
    const magenta = '\u001b[35m'
    const cyan = '\u001b[36m'
    const end = '\u001b[0m'

    // ls -l：权限串整串染蓝（WindTerm 逐字符四色，本引擎一条匹配只有一种配色）、
    // 大小 cyan、时钟整段 cyan（曾经只有「57」被当成数字）
    const ls = addon.highlightKeywords('-rw-r--r-- 1 dp25 dp25 4096 Oct  9 08:57 report.pdf')
    assert.ok(ls.includes(blue + '-rw-r--r--' + end), ls)
    // 权限串不能被选项规则吃掉前半截（optFlag 中间段只接字母，不接 -）
    assert.equal(ls.includes(yellow), false, ls)
    assert.ok(ls.includes(cyan + '4096' + end))
    assert.ok(ls.includes(cyan + '08:57' + end), 'the whole clock, not half of it')

    // 选项 / 绝对路径 / 体积 / PCI / 十六进制
    const curl = addon.highlightKeywords('curl -sS --max-time=30 -o /tmp/out.json')
    assert.ok(curl.includes(yellow + '-sS' + end) && curl.includes(yellow + '--max-time=30' + end), curl)
    assert.ok(curl.includes(blue + '/tmp/out.json' + end), curl)
    const df = addon.highlightKeywords('df -h /dev/sda2  233G   98G  45%')
    assert.ok(df.includes(cyan + '233G' + end) && df.includes(cyan + '98G' + end), df)
    assert.ok(df.includes(cyan + '45%' + end), df)
    const pci = addon.highlightKeywords('0000:3b:00.0 bridge usb 1-2')
    assert.ok(pci.includes(magenta + '0000:3b:00.0' + end), pci)
    assert.equal(pci.includes(cyan + '00.0'), false, 'the tail of a PCI address is not a bare number')
    assert.ok(addon.highlightKeywords('lspci 00:02.0 VGA compatible').includes(magenta + '00:02.0' + end))
    // 时钟档不把 PCI 地址读成「00:02 加一位小数」：那会和设备地址同起点、抢先命中
    assert.equal(addon.highlightKeywords('lspci 00:02.0').includes(cyan), false)
    assert.ok(addon.highlightKeywords('0x4D7953514C').includes(magenta + '0x4D7953514C' + end))

    // 成功 / 失败 / 信息三档
    assert.ok(addon.highlightKeywords('bash: foo: command not found').includes(red + 'not found' + end))
    assert.ok(addon.highlightKeywords('bad superblock, unsupported option').includes(red + 'bad' + end))
    assert.ok(addon.highlightKeywords('permission denied, try again 1.5 s').includes(red + 'permission denied' + end))
    assert.ok(addon.highlightKeywords('make: *** [Makefile:12] Error 2').includes(red + 'Error' + end))
    assert.ok(addon.highlightKeywords('Query OK, 3 rows affected (0.01 sec)').includes(green + 'OK' + end))
    assert.ok(addon.highlightKeywords('Authentication succeeded for login dp25').includes(green + 'succeeded' + end))
    // 信息档后面紧跟否定式时让位给红档：ACCESS 抢蓝会把「access denied」截成半句
    const auth = addon.highlightKeywords('access denied for user root@10.1.2.3')
    assert.equal(auth.includes(blue + 'access'), false, auth)
    assert.ok(auth.includes(red + 'denied' + end), auth)

    // 负例：散文、版本号、裸日期、状态码位、重启次数都不染色
    assert.equal(addon.highlightKeywords('the quick brown fox jumps over the lazy dog'), 'the quick brown fox jumps over the lazy dog')
    assert.equal(addon.highlightKeywords('nginx version: nginx/1.20.1 built with OpenSSL/3.0.2'), 'nginx version: nginx/1.20.1 built with OpenSSL/3.0.2')
    assert.equal(addon.highlightKeywords('2026-11-03 report'), '2026-11-03 report')
    assert.equal(addon.highlightKeywords('"GET / HTTP/1.1" 500'), '"GET / HTTP/1.1" 500')
    const restart = addon.highlightKeywords('restarts 12 (30s ago)')
    assert.equal(restart.includes(cyan + '12'), false, restart)

    // 与共享对象同引用：hex 与数据库组、devAddr 与内核组各只留一份正则
    const dmesg = presetByName(keywordPresets, 'Linux kernel & dmesg')
    const db = presetByName(keywordPresets, 'Database & SQL')
    const devAddr = dmesg.keywords.find(k => k.keyword.includes('[0-9a-f]{4}:'))
    const hex = db.keywords.find(k => k.keyword.includes('0x[0-9a-f]{2,}'))
    assert.ok(devAddr && shell.keywords.includes(devAddr), 'shell and dmesg reuse the same PCI rule object')
    assert.ok(hex && shell.keywords.includes(hex), 'shell and database reuse the same hex rule object')
    assert.equal(db.keywords.filter(k => k.keyword.includes('0x[0-9a-f]')).length, 1)
  })

  test('结构档并进其他组后不改变既有预设的结论', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const byName = n => presetByName(keywordPresets, n)
    const all = new KeywordHighlighterAddon(
      keywordPresets.reduce((acc, p) => acc.concat(p.keywords), [])
    )
    const red = '\u001b[31m'
    const green = '\u001b[32m'
    const cyan = '\u001b[36m'
    const end = '\u001b[0m'

    // 状态码分色仍然归 HTTP 组：num 把「引号后」和「status[=:] 后」的位置让了出去
    assert.ok(all.highlightKeywords('"GET / HTTP/1.1" 500 1').includes(red + '500' + end))
    assert.ok(all.highlightKeywords('"GET / HTTP/1.1" 200 1').includes(green + '200' + end))
    const req = all.highlightKeywords('request_time=0.012 upstream_response_time=0.008 status=404')
    assert.ok(req.includes(cyan + 'request_time=0.012' + end), req)
    assert.ok(req.includes('\u001b[33mstatus=404' + end), req)
    // 体积单位整段染色，单位尾巴不再只染数字那一半
    assert.ok(all.highlightKeywords('size 220 MB/s, 0.01 sec, 12 minutes').includes(cyan + '220 MB/s' + end))
    assert.ok(all.highlightKeywords('took 1.5 s').includes(cyan + 'took 1.5 s' + end))
    // PCI 地址不被「hh:mm + 小数」的时钟抢走（ls -l 的 08:57 仍然整段是时间戳）
    assert.ok(all.highlightKeywords('lspci 00:02.0 VGA').includes('\u001b[35m00:02.0' + end))
    assert.ok(all.highlightKeywords('Oct  9 08:57 report').includes(cyan + '08:57' + end))
    // Docker 的 Completed/Succeeded 与共享 wordOk 同色：黄绿之争消失，两处都绿
    for (const name of ['Docker & Kubernetes', 'Shell & command output']) {
      assert.ok(new KeywordHighlighterAddon(byName(name).keywords)
        .highlightKeywords('Job my-job Completed Succeeded').includes(green + 'Completed' + end), name)
    }
    // 内核组仍然吃得到 PCI 地址（改共享只是换了引用，不是换了规则）
    assert.ok(new KeywordHighlighterAddon(byName('Linux kernel & dmesg').keywords)
      .highlightKeywords('pci 0000:3b:00.0').includes('\u001b[35m0000:3b:00.0' + end))
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

  test('presets that share a rule only add it once', async () => {
    const { keywordPresets, mergeKeywordPreset } = await loadPresets()
    const names = ['Networking', 'Docker & Kubernetes', 'HTTP & web logs', 'Auth & security']
    const merged = names
      .map(name => presetByName(keywordPresets, name))
      .reduce((acc, preset) => mergeKeywordPreset(acc, preset), [])
    const patterns = merged.map(k => k.keyword)

    assert.equal(new Set(patterns).size, patterns.length)
    // the shared IPv4 rule is in all four of them
    const ipv4 = presetByName(keywordPresets, 'Networking').keywords.find(k => k.keyword.includes('25[0-5]'))
    assert.ok(ipv4, 'Networking carries the IPv4 rule')
    assert.equal(patterns.filter(k => k === ipv4.keyword).length, 1)
    for (const name of ['Docker & Kubernetes', 'HTTP & web logs', 'Auth & security']) {
      assert.ok(presetByName(keywordPresets, name).keywords.includes(ipv4), `${name} reuses the same IPv4 rule object`)
    }
  })

  test('merged rules keep whole phrases intact', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const byName = n => keywordPresets.find(p => p.name === n)
    const addon = n => new KeywordHighlighterAddon(byName(n).keywords)
    const cyan = '\u001b[36m'
    const red = '\u001b[31m'

    const end = '\u001b[0m'
    // Python 栈头是整句，不被共享报错词表抢成前半截
    assert.ok(addon('Exceptions & Stack Traces')
      .highlightKeywords('Traceback (most recent call last):').includes(red + 'Traceback (most recent call last)' + end))
    // docker ps 的退出码状态：括号结尾不能把 \b 锚断掉整条交替
    assert.ok(addon('Docker & Kubernetes').highlightKeywords('Exited (137) 2 minutes ago').includes(red + 'Exited (137)' + end))
    assert.ok(addon('Docker & Kubernetes').highlightKeywords('Exited (0) 3 minutes ago').includes('\u001b[32mExited (0)' + end))
    // 方括号里的计时器连括号一起染，裸时钟不吞括号
    assert.ok(addon('Timestamps').highlightKeywords('[00:12:34.567] worker').includes(cyan + '[00:12:34.567]' + end))
    // BSD 时间戳带小数秒时整段是一个时间戳
    assert.ok(addon('HTTP & web logs')
      .highlightKeywords('[Wed Oct 09 08:57:36.123456 2026]').includes(cyan + 'Oct 09 08:57:36.123456' + end))
    // Apache「模块:级别」写法
    assert.ok(addon('HTTP & web logs').highlightKeywords('[core:error] boom').includes(red + '[core:error]' + end))
    assert.ok(addon('HTTP & web logs').highlightKeywords('[ssl:warn] cert').includes('\u001b[33m[ssl:warn]' + end))
    // 时长 key=value：单位尾巴必须是单位，不能把下一个 key 的前缀吃掉
    const both = addon('HTTP & web logs')
      .highlightKeywords('request_time=0.012 upstream_response_time=0.008')
    assert.ok(both.includes(cyan + 'request_time=0.012\u001b[0m'), 'unit tail must not eat the next key')
    assert.ok(both.includes(cyan + 'upstream_response_time=0.008\u001b[0m'))
    // 合并后的接口名规则不再把 IP/掩码的尾巴当接口
    assert.equal(addon('Networking').highlightKeywords('address 10.1.2.3/24 masked').includes('\u001b[34m'), false)
  })

  test('Syslog preset colours severity and unit lifecycle', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(presetByName(keywordPresets, 'Syslog & systemd').keywords)
    const out = addon.highlightKeywords('Oct  9 08:57:36 host systemd[1]: nginx.service: Failed with result exit-code')

    assert.ok(out.includes('\u001b[31mFailed'))
    assert.ok(out.includes('\u001b[34mnginx.service'))
    assert.ok(addon.highlightKeywords('Started nginx.service.').includes('\u001b[32mStarted'))
  })

  test('HTTP preset colours status codes by class', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(presetByName(keywordPresets, 'HTTP & web logs').keywords)

    assert.ok(addon.highlightKeywords('"GET / HTTP/1.1" 500 1').includes('\u001b[31m500'))
    assert.ok(addon.highlightKeywords('"GET / HTTP/1.1" 404 1').includes('\u001b[33m404'))
    assert.ok(addon.highlightKeywords('"GET / HTTP/1.1" 200 1').includes('\u001b[32m200'))
    // a three-digit number that is not a status code stays plain
    assert.equal(addon.highlightKeywords('the 500 page'), 'the 500 page')
  })

  test('Docker preset keeps pod names whole and colours port mappings', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(presetByName(keywordPresets, 'Docker & Kubernetes').keywords)
    const out = addon.highlightKeywords('nginx-7d9f8c6b5-x2k4p   0/1   CrashLoopBackOff   12 (30s ago)   5m')

    assert.ok(out.includes('\u001b[35mnginx-7d9f8c6b5-x2k4p'))
    assert.ok(out.includes('\u001b[31mCrashLoopBackOff'))
    assert.ok(out.includes('\u001b[35m12 (30s ago)'))
    assert.ok(addon.highlightKeywords('0.0.0.0:8080->80/tcp').includes('\u001b[35m8080->80/tcp'))
  })

  test('Git preset colours conflicts and leaves the status letters alone', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(presetByName(keywordPresets, 'Git').keywords)
    const conflict = addon.highlightKeywords('CONFLICT (content): Merge conflict in src/x.js')

    assert.ok(conflict.includes('\u001b[31mCONFLICT'))
    assert.ok(conflict.includes('\u001b[34msrc/x.js'))
    // "M " and "??" are too short to colour without hitting ordinary text
    assert.equal(addon.highlightKeywords(' M src/x.js'), ' M \u001b[34msrc/x.js\u001b[0m')
  })

  test('Database preset colours SQL, NULL, errors and client status lines', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(presetByName(keywordPresets, 'Database & SQL').keywords)

    // SQL 语句 + NULL
    const sql = addon.highlightKeywords('SELECT id FROM users WHERE name IS NULL')
    assert.ok(sql.includes('\u001b[34mSELECT'))
    assert.ok(sql.includes('\u001b[34mFROM'))
    assert.ok(sql.includes('\u001b[34mWHERE'))
    assert.ok(sql.includes('\u001b[35mNULL'))

    // 引用标识符（反引号按段匹配：`db` 与 `t` 各一段）
    assert.ok(addon.highlightKeywords('SELECT `db`.`t`').includes('\u001b[34m`db`'))
    assert.ok(addon.highlightKeywords('SELECT "public"."users"').includes('\u001b[34m"public"."users"'))

    // 报错与 Redis 错误回复
    const err = addon.highlightKeywords('ERROR 1146 (42S02): Table users does not exist')
    assert.ok(err.includes('\u001b[31mERROR'))
    assert.ok(err.includes('\u001b[31mdoes not exist'))
    assert.ok(addon.highlightKeywords("(error) ERR unknown command 'foo'").includes('\u001b[31m(error)'))

    // 状态行与耗时（mysql / psql / redis-cli）
    const status = addon.highlightKeywords('Query OK, 3 rows affected (0.01 sec)')
    assert.ok(status.includes('\u001b[32mQuery OK'))
    assert.ok(status.includes('\u001b[32mrows affected'))
    assert.ok(status.includes('\u001b[36m(0.01 sec)'))
    assert.ok(addon.highlightKeywords('(integer) 42').includes('\u001b[35m(integer)'))
    assert.ok(addon.highlightKeywords('(3 rows)').includes('\u001b[32m(3 rows)'))

    // 单元格值：时间戳 / UUID / 十六进制
    assert.ok(addon.highlightKeywords('2026-10-14 19:22:31').includes('\u001b[36m2026-10-14'))
    assert.ok(addon.highlightKeywords('550e8400-e29b-41d4-a716-446655440000').includes('\u001b[35m550e8400'))
    assert.ok(addon.highlightKeywords('0x4D7953514C').includes('\u001b[35m0x4D7953514C'))

    // 负例：普通 prose 不动
    const prose = 'the quick brown fox jumps over the lazy dog'
    assert.equal(addon.highlightKeywords(prose), prose)
  })
})
