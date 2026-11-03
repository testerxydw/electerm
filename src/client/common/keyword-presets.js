/**
 * Built-in keyword highlight presets, offered next to keyword import/export.
 * Applying a preset adds its rules after the user's existing ones (skipping
 * rules already present), so it never discards custom keywords.
 *
 * These rule sets are written for terminal output. The open-source
 * collections that exist are close, but none of them is drop-in:
 *   - grc (github.com/garabik/grc) ships ~60 per-command `conf.*` files
 *     (conf.dockerps, conf.kubectl, conf.systemctl, conf.gcc, conf.log, ...).
 *   - tailspin (github.com/bensadeh/tailspin) ships fixed highlight groups:
 *     dates, durations, keywords (severities, booleans, nulls, HTTP methods),
 *     URLs, numbers, IPv4, quotes, unix paths, HTTP methods, UUIDs,
 *     key-value pairs, pointer addresses, unix processes.
 *   - VS Code Log File Highlighter
 *     (github.com/emilast/vscode-logfile-highlighter) ships a log4net-style
 *     TextMate grammar: dates/times, log levels, numeric and .NET constants,
 *     strings, GUIDs, MACs, exception types, stack traces, URLs, namespaces.
 *   - lnav (github.com/tstack/lnav) ships ~60 JSON log format definitions
 *     (access_log, error_log, journald_json, java_log, redis_log, ...).
 * They are per-command shell wrappers or editor grammars, and none of them
 * uses ANSI colour names, so these presets follow their categories rather
 * than their files.
 *
 * Database clients are the same story: mysql, psql and redis-cli colour their
 * own output, and neither DBeaver nor DataGrip exposes a reusable rule set, so
 * the Database preset follows the shape of their output instead.
 *
 * ## 整理纪律（这一版就是按这四条合并过的）
 *
 * 1. **一条正则只在本文件里出现一次。** 多个预设需要同一类信号（IP、时间戳、
 *    时长、报错词）时引用下面同一个共享规则对象，不各自重抄。重抄出来的「只差
 *    一点」的变体（时长单位列表抄了 4 份、异常类名抄了 2 份、时间戳抄了 3 份）
 *    会让同时勾选多个预设的人拿到多条互相重叠的规则，它们各自把整行扫一遍，
 *    同一段文字被谁染色取决于排列顺序。
 * 2. **共享规则的配色在定义处钉死。** mergeKeywordPreset 按正则字符串去重：同一条
 *    正则在两个预设里配不同颜色时，先应用的预设赢，后应用的那条被静默丢掉，设置
 *    面板上的「已应用 N 条」和实际生效的着色就对不上了。
 * 3. **同色 + 同类才合并成一条备选式**，且保持原有先后顺序：同一位置上排在前面的
 *    备选赢，与原来「排在前面的规则赢」一致，所以合并不改变着色。不同色（严重级别
 *    的红/黄/青/蓝）绝不合并——那正是预设要表达的区别。
 * 4. **每条规则都按「全部预设同时勾选」的最坏情况计成本**：终端插件对每一行、每条
 *    规则各扫一遍整行（O(规则数 × 行长度)），规则数同时决定常驻内存和每字节耗时。
 */

// ---- 共享片段 ----
const ipv4 = '\\b(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}(/\\d{1,2})?\\b'
const ipv6 = '(?<![\\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?::[0-9a-f]{1,4}){1,7}|::)(?![\\w:])'
const mac = '\\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b|\\b[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}\\b'
const srcExt = 'c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|go|rs|java|kt|kts|scala|ts|tsx|js|jsx|mjs|cjs|py|pyi|rb|php|cs|swift|zig|lua|pl|pm|ex|exs|erl|dart|sh|bash|zsh|ps1|sql|json|ya?ml|toml|ini|cfg|conf|properties|styl|css|scss|sass|less|html|vue|svelte|md|txt|log|csv|tsv'
// source file name, and file:line(:col) as printed by compilers and stack traces
const srcFile = '\\b[\\w./~-]+\\.(' + srcExt + ')\\b'
const srcLoc = '\\b[\\w./~-]+\\.(' + srcExt + ')\\b(:\\d+){1,2}'

// 时间戳：ISO 8601 / BSD syslog / 裸时钟，合成一条（原本三条各扫一遍整行，且
// 各预设给它们配过 cyan / magenta / blue 三种色）。前后排除引号和冒号，
// 这样 JSON 里的 "created_time":"2026-10-09 10:24:57" 不会被当成时间戳。
const ts = '(?<![":])\\b(?:\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?(?:Z|[+-]\\d{2}:?\\d{2})?' +
  '|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?' +
  '|\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?)\\b(?![":])'

// 方括号里的时间戳：nginx/Apache 的 [09/Oct/2026:08:57:36 +0800]、dmesg 的 [   12.345678]、
// 测试框架的 [00:12:34.567]
const tsBracket = '\\[\\d{2}/\\w{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4}\\]|\\[\\s*\\d+\\.\\d+\\]|\\[\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?\\]'

// 时长：数字 + 单位（原本 4 份单位列表各抄一遍，全是 cyan）。长单位排在单字母
// 之前，否则 "10 min" 会被 [smh] 抢走前半截。
const dur = '\\b\\d+(?:\\.\\d+)?\\s?(?:ns|us|µs|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|[smh])\\b'

// 时长：key=value 形式（request_time=0.012 / took 12ms / elapsed: 3.2 s）。
// 单位必须是真实单位词，不能写成「任意 1-6 个字母」——那会让
// request_time=0.012 upstream_response_time=0.008 里的 "upstre" 被当成单位吃掉，
// 顺带毁掉后半截 key 的匹配。
const durKey = '\\b(?:request_time|upstream_response_time|request_time_ms|duration|latency|elapsed|took|wall ?time)(?:[=:]\\s*|\\s+)\\d+(?:\\.\\d+)?(?:\\s?(?:ns|us|µs|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|[smh])\\b)?'

// 体积与吞吐：字节数、[KMGT]i?B，以及 dmesg 的 220 MB/s
const size = '\\b\\d+(?:\\.\\d+)?\\s?(?:bytes?|[KMGT]i?B)(?:/s)?\\b'

// 日志级别与泛用报错词。红档一条打尽：级别词（emerg/alert/crit/fatal/panic/severe）
// 和「这就是失败」的词（error/failed/denied/timeout/corrupt/core dumped/...）在
// syslog、应用日志、内核、构建输出里是同一个信号，原本抄了 5 份互有遗漏的列表。
// 不含 TRACEBACK：终端插件的重叠裁决是「同起点取更短」，这条一旦包含 Traceback，
// 崩溃栈预设里 'Traceback (most recent call last)' 整句就会被前半截抢掉。
//
// WindTerm 默认 Linux 方案（安装包内 terminal/schemes/linux/linux.lexer 的
// token.error-token 档）里有、我们原先缺的失败词在这里补齐：bad/incorrect/
// invalid/unsupported/wrong/cannot，以及「助动词 + not」的否定式（command not
// found、table does not exist、could not resolve）。WindTerm 还把 deprecated/
// disabled/unknown/false/none 归进 error 档，本文件按自己的口径分别留在黄档
// （lvlWarn）与 magenta（nullBool）——那几处配色在别的预设里另有用途，跟色会让
// 已应用过预设的人拿到和面板不一致的结论。裸 not / no 也不跟：终端的重叠裁决是
// 同起点取更短，红档的「no <词>」会把 Git 预设的整句黄档（no changes added to
// commit）抢成红色。
const lvlError = '\\b(?:EMERG(?:ENCY)?|ALERT|CRITICAL|CRIT|SEVERE|FATAL|PANIC(?:KED)?|' +
  'ERRORS?|ERR|EXCEPTIONS?|CAUSED BY|' +
  'FAIL(?:ED|ING|URE|URES)?|DENIED|DENY|REFUSED|REJECTED|TIMEOUT|TIMED OUT|UNREACHABLE|' +
  'CORRUPT(?:ED|ION)?|SEGFAULT|SEGMENTATION FAULT|CORE[- ]DUMP(?:ED|ING)?|DROPPED|' +
  'ABORT(?:ED|ING)?|CRASH(?:ED|ING|ES)?|EXPIRED|REVOKED|VULNERABILIT(?:Y|IES)|' +
  'BAD|INCORRECT|INVALID|UNSUPPORTED|WRONG|MISMATCH|MISCONFIGURED|MISSING|' +
  'UNEXPECTED|UNAVAILABLE|UNRESOLVED|' +
  'CANNOT|CAN NOT|COULD ?NOT|SHOULD ?NOT|WOULD ?NOT|WILL ?NOT|DOES NOT|DID NOT|' +
  "CAN'T|COULDN'T|SHOULDN'T|WOULDN'T|WON'T|DIDN'T|DOESN'T|" +
  'NOT (?:FOUND|ALLOWED|PERMITTED|AVAILABLE|SUPPORTED|RESPONDING|AUTHENTICATED|' +
  'INITIALIZED|ESTABLISHED|REACHABLE|VALID)|' +
  'NO SUCH \\w+|NO (?:ROUTE|PERMISSIONS?|RESPONSE|SPACE|MATCHING|ACCESS|AUTHENTICATION)|' +
  'UNDEFINED (?:REFERENCE|SYMBOL)|PERMISSION DENIED|EACCES|ENOENT)\\b|(?:✗|✘|✖)'
// disabled/unknown 在 WindTerm 是红档，但「未开启 / 认不出来」在 syslog、构建、
// 内核日志里是提醒而不是失败，留在黄档；顺带把只有网络预设认得的 incompatible/
// legacy 提到共享黄档，让日志侧的「兼容性警告」也能染上色。
const lvlWarn = '\\b(?:WARN(?:ING)?S?|DEPRECATED|DEPRECATION|OUTDATED|HINT|DISABLED|UNKNOWN|INCOMPATIBLE|LEGACY)\\b'
const lvlNotice = '\\bNOTICE\\b'
// INFO 在 syslog 里原本是 cyan、在应用日志里是 green：同一条正则两种配色会被去重
// 掉一种，统一取 cyan（green 留给「状态正常/成功」这一类词）。
const lvlInfo = '\\bINFO(?:RMATION|RMATIONAL)?\\b'
const lvlDebug = '\\b(?:DEBUG|TRACE|VERBOSE)\\b'

// 异常类名：应用日志与崩溃栈两个预设原本各抄一份，一份不认包名前缀
// （java.lang.NullPointerException 只染后半截），一份不认 Throwable/Fault/Panic 结尾。
const exc = '\\b(?:[\\w$]+\\.)*[A-Z][\\w$]*(?:Error|Exception|Throwable|Fault|Panic)\\b'

// NULL 与布尔（含 Python 适配器的 None、Redis 的 nil）。前面的 (?<![\w"]) 把
// JSON 字符串值里的 "null"/"true" 排掉——数据库网格里绝大多数值就是 JSON。
const nullBool = '(?<![\\w"])\\b(?:NULL|NIL|NONE|UNDEFINED|NaN|TRUE|FALSE)\\b'

// ---- 共享规则：正则与配色一起定义一次，预设引用同一个对象 ----
const rule = {
  ipv4: { keyword: ipv4, color: 'cyan' },
  ipv6: { keyword: ipv6, color: 'magenta' },
  mac: { keyword: mac, color: 'magenta' },
  ts: { keyword: ts, color: 'cyan' },
  tsBracket: { keyword: tsBracket, color: 'cyan' },
  dur: { keyword: dur, color: 'cyan' },
  durKey: { keyword: durKey, color: 'cyan' },
  size: { keyword: size, color: 'cyan' },
  srcFile: { keyword: srcFile, color: 'blue' },
  srcLoc: { keyword: srcLoc, color: 'magenta' },
  lvlError: { keyword: lvlError, color: 'red' },
  lvlWarn: { keyword: lvlWarn, color: 'yellow' },
  lvlNotice: { keyword: lvlNotice, color: 'cyan' },
  lvlInfo: { keyword: lvlInfo, color: 'cyan' },
  lvlDebug: { keyword: lvlDebug, color: 'blue' },
  exc: { keyword: exc, color: 'red' },
  nullBool: { keyword: nullBool, color: 'magenta' }
}

export const keywordPresets = [
  {
    name: 'Networking',
    description: 'Switch and router CLI output (Cisco, Juniper, Arista, HPE Aruba and Comware, Huawei, Ubiquiti EdgeOS, MikroTik, Hirschmann, Moxa and similar): link state, errors, syslog severity, IPs, MACs, interfaces',
    keywords: [
      // syslog severity: %FACILITY-<severity>-MNEMONIC
      { keyword: '%[A-Z0-9_]+-[0-3]-[A-Z0-9_]+', color: 'red' },
      { keyword: '%[A-Z0-9_]+-4-[A-Z0-9_]+', color: 'yellow' },
      { keyword: '%[A-Z0-9_]+-[5-7]-[A-Z0-9_]+', color: 'cyan' },
      // link / port state. Comware "ADM" and EdgeOS "A/D" are admin down,
      // EdgeOS "u/D" is admin up with the link down, "u/u" is up/up
      { keyword: '\\b(administratively down|err-?disabled|notconnect|not connected|link down|down|adm)\\b|\\b[Au]/D\\b', color: 'red' },
      // 这一份报错词表刻意保留自己的 JSON 边界排除：交换机/控制器的 JSON 回显里
      // "errors":0、"denied_count":0 是键名，不能染色（共享的 lvlError 没有这对
      // 护栏，套到这里会把干净的状态输出全染红）
      { keyword: '(?<![":])\\b(errors?|fail(ed|ure|s)?|denied|deny|invalid|incomplete|unreachable|timeout|timed out|crc|runts|giants|collisions?|input errors|output errors|discard(s|ed)?|drop(s|ped)?|blocking|blk|bkn|broken|alarm|critical|access denied)\\b(?![":])', color: 'red' },
      { keyword: '(?<![":])\\b(up|connected|link up|permit(ted)?|forwarding|fwd|full|established|active|success(ful)?|enabled?|ok|online|reachable|root)\\b(?![":])|\\bu/u\\b', color: 'green' },
      { keyword: '(?<![":])\\b(warning|warn|half|learning|lrn|listening|lis|standby|disabled?|shutdown|pending|unknown|desg|altn|alternate|backup)\\b(?![":])', color: 'yellow' },
      // 接口名：Cisco/Arista/Dell(Gi1/0/1, Et1, Po1, Vlan600)、Huawei(XGigabitEthernet0/0/1,
      // 40GE1/0/1, Eth-Trunk1, Vlanif10)、HP Comware(XGE1/0/1, BAGG1)、ProCurve(Trk1)、
      // MikroTik(ether1, sfp-sfpplus1)、EdgeOS(eth0, eth1.100, switch0, br0)、
      // Juniper(ge-0/0/0, irb.100, em0)、槽位口(1/1, cpu/1, lag/1)。
      // 三段原本各自一条、同色 blue，合成一条并保持原顺序：同一位置上排在前的
      // 备选赢，与原来「排在前面的规则赢」等价，着色不变。裸槽位加了 (?<![\w./])
      // 护栏，不再把 10.1.2.3/24 的尾巴 "3/24" 认成接口。
      { keyword: '\\b(GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|XGigabitEthernet|FastEthernet|Ethernet|Eth-Trunk|Port-channel|Bridge-Aggregation|Route-Aggregation|Management|Loopback|Tunnel|MEth|Vlanif|Vlan|BAGG|sfp-sfpplus|sfp|ether|switch|bridge|bond|wlan|pppoe|Trk|ae|br|XGE|FGE|GE|Gi|Te|Twe|Fo|Hu|Fa|Eth|Et|Ma|Po|Lo|Tu|Vl|\\d{2,3}GE)\\s?\\d+(/\\d+){0,3}(\\.\\d+)?\\b|\\b(ge|xe|et|fe|mge|lt|gr)-\\d+/\\d+/\\d+(\\.\\d+)?\\b|\\birb(\\.\\d+)?\\b|\\b(em|fxp|me)\\d+\\b|\\b(cpu|vlan|lag|ch)\\s?/?\\d+(/\\d+)?\\b|(?<![\\w./])\\d/\\d{1,2}(/\\d{1,2})?\\b', color: 'blue' },
      rule.mac,
      rule.ipv4
    ]
  },
  {
    name: 'Syslog & systemd',
    description: 'journalctl, /var/log/syslog and messages, systemd unit output: severity, unit lifecycle states, unit names, timestamps, PIDs',
    keywords: [
      // severity（红档合并成共享的 lvlError，worst-first 的次序靠它自己排在前面）
      rule.lvlError,
      rule.lvlWarn,
      rule.lvlNotice,
      rule.lvlInfo,
      rule.lvlDebug,
      // systemd unit lifecycle（failed 已由 lvlError 覆盖，这里不再重列）
      { keyword: '\\b(dead|inactive|killed|masked|not[- ]found)\\b', color: 'red' },
      { keyword: '\\b(started|starting|active|running|reached|succeeded|success(fully)?|listening|mounted|finished|enabled)\\b', color: 'green' },
      { keyword: '\\b(stopping|stopped|reloading|reload(ed)?|deactivating|activating|waiting|pending|scheduled|restart(ing|ed)?|retrying|degraded)\\b', color: 'yellow' },
      // unit names: nginx.service, ssh.socket, systemd-tmpfiles-clean.timer
      { keyword: '\\b[a-z0-9][a-z0-9@._-]*\\.(service|socket|target|timer|mount|automount|device|path|slice|scope|swap)\\b', color: 'blue' },
      rule.ts,
      { keyword: '\\b(pid|PID)[= ]\\d+\\b', color: 'magenta' },
      { keyword: '\\b(sshd|sudo|systemd|crond?|dbus-daemon|NetworkManager|polkitd|rsyslogd|logind|kernel)\\[[0-9]+\\]', color: 'blue' },
      rule.ipv4,
      rule.ipv6
    ]
  },
  {
    name: 'Linux kernel & dmesg',
    description: 'dmesg, the kernel ring buffer and boot messages: OOM killer, segfaults, hardware and I/O errors, device, link and driver events',
    keywords: [
      { keyword: '\\b(kernel panic|general protection fault|unable to handle (kernel )?paging request|segfault|out of memory|oom[- ]kill(er)?|killed process|call trace|hardware error|machine check|medium error|unrecoverable (read|error)|i/o error|buffer i/o error|ext4-fs error|xfs .*corruption|reset .* failed|device not ready|link is not ready|firmware (bug|error)|stack corruption|bad rip value|blocked for more than)\\b', color: 'red' },
      // 泛用报错词（error/err/fatal/denied/timeout/dropped/refused/corrupt 全在其中）
      // 与 syslog、应用日志、构建输出共用同一条规则
      rule.lvlError,
      { keyword: '\\b(warn(ing)?|deprecated|falling back|retry(ing)?|deferred|link is down|disconnected|removed|suspended|unstable|degraded|overcurrent|throttl(ed|ing)|thermal|under-voltage|over-voltage)\\b', color: 'yellow' },
      { keyword: '\\b(link is up|link up|registered|initialized|attached|mounted|enabled|detected|ready|success(ful)?|started|inserted|now attached|power on|resumed|link becomes ready)\\b', color: 'green' },
      // device names
      { keyword: '\\b(ata\\d+(\\.\\d+)?|sd[a-z]\\d*|nvme\\d+n\\d+(p\\d+)?|mmcblk\\d+(p\\d+)?|dm-\\d+|md\\d+|eth\\d+|wlan\\d+|enp\\d+s\\d+|eno\\d+|wlp\\d+s\\d+|usb \\d+-\\d+(\\.\\d+)?|tty(S|USB|ACM)\\d+|br-\\d+|veth[0-9a-f]+)\\b', color: 'blue' },
      { keyword: '\\b[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\\.\\d\\b|\\b[0-9a-f]{4}:[0-9a-f]{4}\\b', color: 'magenta' },
      { keyword: '\\bcpu\\d+\\b', color: 'magenta' },
      { keyword: '\\bLinux version \\S+\\b', color: 'cyan' },
      // dmesg 的 [   12.345678] 前缀与体积/吞吐，与 nginx 日志、数据库页共用
      rule.tsBracket,
      rule.size
    ]
  },
  {
    name: 'HTTP & web logs',
    description: 'nginx and Apache access and error logs, and most web framework request logs: methods, status codes by class, latency, upstream hosts, user agents, paths',
    keywords: [
      // Apache / nginx 时间戳先行，日期片段才不会被 path / host:port 规则捡走
      rule.tsBracket,
      rule.ts,
      // 状态码按类分色。lookbehind 要求请求行的收尾引号，普通三位数才不会被误染；
      // 「status=4xx」这种键值写法并入同一色的一条规则（原本单独两条）
      { keyword: '(?:(?<="\\s)|\\bstatus[=:]\\s*)5\\d{2}\\b', color: 'red' },
      { keyword: '(?:(?<="\\s)|\\bstatus[=:]\\s*)4\\d{2}\\b', color: 'yellow' },
      { keyword: '(?<="\\s)3\\d{2}\\b', color: 'cyan' },
      { keyword: '(?<="\\s)[12]\\d{2}\\b', color: 'green' },
      // URL、请求行、协议版本：三条同色 blue，合成一条
      // 请求行 / URL / 协议版本 / 独立路径：原本四条同色 blue，合成一条。
      // 路径分支的 (?<![\w/]) 是为了不吃到日期里的 "/09"、URL 里的 "//"、"and/or" 的 "/or"
      { keyword: '\\bhttps?://[^\\s"\']+|\\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\\s+\\S+\\s+HTTP/|\\bHTTP/\\d(?:\\.\\d)?|(?<![\\w/])/[\\w.~%!$&()*+,;=:@-]{2,}', color: 'blue' },
      rule.dur,
      rule.durKey,
      { keyword: '\\bupstream\\b', color: 'magenta' },
      // host:port, but not the "08:57" inside a timestamp
      { keyword: '\\b(?:[a-z][a-z0-9.-]*|\\d{1,3}(?:\\.\\d{1,3}){3}):\\d{2,5}\\b', color: 'magenta' },
      { keyword: '\\b(Mozilla/5\\.0|curl/\\S+|Wget/\\S+|Googlebot(?:/\\S+)?|bingbot(?:/\\S+)?|python-requests/\\S+|Go-http-client/\\S+|okhttp/\\S+|PostmanRuntime/\\S+|Apache-HttpClient/\\S+|axios/\\S+|node-fetch/\\S+|Electron/\\S+)\\b', color: 'magenta' },
      rule.ipv4,
      // error-log 的级别。前缀字符类里必须带冒号，才认得 Apache 的 [core:error]、
      // [ssl:warn] 这种「模块:级别」写法（原来只认 [error]，真实 error.log 一级都不染）
      { keyword: '\\[[\\w.:-]*(?:EMERG|ALERT|CRIT(?:ICAL)?|ERROR|ERR)\\]', color: 'red' },
      { keyword: '\\[[\\w.:-]*(?:WARN(?:ING)?|NOTICE)\\]', color: 'yellow' },
      { keyword: '\\[[\\w.:-]*(?:INFO|DEBUG)\\]', color: 'cyan' }
    ]
  },
  {
    name: 'Application log levels',
    description: 'Generic application logs (log4j/slf4j, Python logging, Go slog, Rust tracing, Node winston/pino): levels, timestamps, thread and logger names, exception types, tracing ids',
    keywords: [
      rule.lvlError,
      rule.lvlWarn,
      rule.lvlNotice,
      rule.lvlInfo,
      rule.lvlDebug,
      rule.nullBool,
      rule.ts,
      rule.dur,
      // tracing / correlation ids, in "k=v" and in JSON "k": "v" form
      { keyword: '\\b(trace_?id|span_?id|request_?id|correlation_?id|session_?id|user_?id)["\']?\\s*[=:]\\s*["\']?[\\w.:-]+', color: 'magenta' },
      rule.exc,
      // logger / package names: com.example.Foo, my.pkg.module
      { keyword: '\\b([A-Za-z_][A-Za-z0-9_]*\\.){2,}[A-Za-z_][A-Za-z0-9_]*\\b', color: 'blue' },
      // thread names: [main], [worker-3], [pool-2-thread-1]
      { keyword: '\\[(main|worker[- ]?\\d+|pool-\\d+-thread-\\d+|Thread-\\d+|goroutine \\d+|[A-Za-z0-9_-]{1,20}-\\d+)\\]', color: 'blue' },
      rule.srcLoc,
      rule.ipv4,
      rule.ipv6
    ]
  },
  {
    name: 'Exceptions & Stack Traces',
    description: 'Java/Python/Go crash signatures: exception classes, Caused by chains, at frames, Traceback blocks, native signal aborts and panic lines',
    keywords: [
      // Caused by / panic / core dumped / error 这些词已在共享的 lvlError 里
      rule.lvlError,
      rule.exc,
      { keyword: '\\bat [\\w$.]+\\([^)]*\\)', color: 'blue' },
      // Python 栈头整句（含括号）与 "stack trace"：共享的 lvlError 不含 TRACEBACK，
      // 所以这里不会和它抢前半截
      { keyword: 'Traceback \\(most recent call last\\)|\\bstack ?trace\\b', color: 'red' },
      { keyword: 'File "[^"]+", line \\d+', color: 'yellow' },
      { keyword: '\\b(SIGSEGV|SIGABRT|SIGKILL)\\b', color: 'red' }
    ]
  },
  {
    name: 'Timestamps',
    description: 'Standalone timestamp shapes for mixed-format output: ISO 8601, BSD syslog dates, bracketed timers, bare clock times and durations',
    keywords: [
      rule.ts,
      rule.tsBracket,
      rule.dur
    ]
  },
  {
    name: 'Docker & Kubernetes',
    description: 'docker ps/images/compose and kubectl get/describe/logs output: container states, pod phases and events, resource references, image tags and digests, ports, ages, restart counts',
    keywords: [
      // container states and pod phases that mean trouble（Exited (137) 同色，并入）。
      // Exited (N) 必须以独立分支放在 \b...\b 之外：结尾是「)」（非单词字符），
      // 后面跟空格时 \b 不成立，整条交替会被这个尾锚全部判失败。
      { keyword: '\\b(CrashLoopBackOff|ErrImagePull|ImagePullBackOff|CreateContainerConfigError|CreateContainerError|InvalidImageName|OOMKilled|Evicted|Failed|FailedScheduling|Error|BackOff|Unhealthy|Dead|Removing|NotReady|Terminating|NoSchedule)\\b|\\bExited \\([1-9]\\d*\\)', color: 'red' },
      { keyword: '\\b(Pending|ContainerCreating|Init:\\d+/\\d+|PodInitializing|Waiting|SchedulingDisabled|Unknown|Paused|Restarting|Preempting|Completed|Succeeded|Warning)\\b', color: 'yellow' },
      { keyword: '\\b(Running|Ready|Healthy|Active|Bound|Started|Pulled|Created|Available|Deployed|Up \\d+ (second|minute|hour|day|week|month|year)s?)\\b|\\bExited \\(0\\)', color: 'green' },
      // resource references: deployment/nginx, pods/nginx-1, svc/api
      { keyword: '\\b(pods?|deploy(ment)?s?|svc|services?|ingress(es)?|configmaps?|secrets?|statefulsets?|daemonsets?|replicasets?|jobs?|cronjobs?|namespaces?|nodes?|pv|pvc|endpoints?|hpa|events?)/[a-z0-9][a-z0-9.-]*\\b', color: 'blue' },
      // generated pod / container names: nginx-7d9f8c6b5-x2k4p
      { keyword: '\\b[a-z0-9][a-z0-9-]*-[0-9a-f]{5,10}-[a-z0-9]{4,6}\\b', color: 'magenta' },
      // AGE column: 12m, 45s, 3d4h
      { keyword: '\\b\\d+[dhms](\\d+[dhms])*\\b', color: 'cyan' },
      // restart counts: "3 (4m ago)"
      { keyword: '\\b\\d+ \\(\\d+[dhms]+ ago\\)', color: 'magenta' },
      // 镜像：常用镜像名（带 tag）、registry 引用、sha256 摘要。三条原本同色
      // magenta，合成一条并保持原顺序；尾部 lookahead 保证 pod 名里的
      // "nginx"（nginx-7d9f8c6b5-x2k4p）不被单独拆开染色
      { keyword: '\\b(nginx|redis|postgres|mysql|mariadb|mongo|alpine|ubuntu|debian|busybox|python|golang|openjdk|eclipse-temurin|rabbitmq|kafka|elasticsearch|traefik|haproxy|caddy|vault|consul|etcd|prometheus|grafana|jenkins|gitlab-runner|fluentd|fluent-bit|metrics-server|kube-[a-z-]+)(:[a-zA-Z0-9._-]+)?(?![\\w-])|\\b[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d+)?/[a-z0-9._/-]+(:[a-zA-Z0-9._-]+)?\\b|\\bsha256:[0-9a-f]{12,64}\\b', color: 'magenta' },
      // ports and port mappings. Two rules, not one alternation: a single rule
      // that matches "0.0.0.0:8080" would resume scanning after it and never
      // see the "8080->80/tcp" that sits inside that span
      { keyword: '\\b\\d{1,5}->\\d{1,5}/(tcp|udp)\\b', color: 'magenta' },
      { keyword: '(?<![\\w])(0\\.0\\.0\\.0|\\*|::):\\d{1,5}\\b', color: 'magenta' },
      rule.ipv4,
      rule.ipv6
    ]
  },
  {
    name: 'Build & test output',
    description: 'gcc/clang, tsc, eslint, make, maven/gradle, go build and pytest/jest/go test/cargo test: diagnostics, file:line:col locations, pass/fail/skip results, timings',
    keywords: [
      // 报错词、✗/✘/✖ 与 vulnerability 都在共享的 lvlError 里（原本是三条 red）
      rule.lvlError,
      rule.lvlWarn,
      { keyword: '\\b(skip|skipped|pending|todo|xfail|xpass|ignored)\\b', color: 'yellow' },
      // 通过/成功：原本两条 green 规则，同色合成一条
      { keyword: '\\b(PASS|PASSED|passed|ok|success|successful|SUCCESS|build succeeded|build success(ful)?|compilation complete|compiled successfully|nothing to do|up to date|all tests passed|done|finished)\\b|✔|✓|√', color: 'green' },
      { keyword: '\\b(building|compiling|linking|bundling|transpiling|minifying|installing|resolving|downloading|fetching|running|executing|starting|cleaning|caching|packaging|publishing)\\b', color: 'blue' },
      rule.srcLoc,
      rule.srcFile,
      rule.dur,
      rule.durKey,
      { keyword: '\\b\\d+(\\.\\d+)?%', color: 'cyan' },
      // 数字+名词组合会与上一行的 green/red 状态词冲突(42 passed 中 passed 应染绿)，
      // 故单独的数字+名词组合不再添加，green/red 单词规则直接覆盖 passed/failed 等
      rule.ipv4
    ]
  },
  {
    name: 'Git',
    description: 'git status/log/diff/fetch/push/pull/merge output: branch and tracking state, changed and untracked files, conflicts, commit ids, diff hunks',
    keywords: [
      // 冲突标记优先于普通 conflict 单词(因为短符号不构成单词边界)
      { keyword: '<{7}|={7}|>{7}', color: 'red' },
      { keyword: '\\b(conflict|conflicts|both modified|both added|both deleted|deleted by (us|them)|added by (us|them)|unmerged|rejected|non-fast-forward|failed to push|detached HEAD|fatal|error|aborting|aborted|refusing to|would be overwritten|not possible to fast-forward)\\b', color: 'red' },
      { keyword: '\\b(up[- ]to[- ]date|already up to date|everything up-to-date|fast-forward|nothing to commit|working tree clean|successfully|created|deleted branch|merged|rebase(d)? successfully)\\b', color: 'green' },
      // ahead of / behind 交给下面那条整句 cyan 规则：两条同时存在时终端会按「短的
      // 先染」只把 "ahead of" 染黄，数据库网格按「长的先染」把整句染青，同一份配置
      // 两处显示不一样
      { keyword: '\\b(modified|deleted|renamed|copied|untracked|staged|unstaged|diverged|no changes added to commit|changes not staged|changes to be committed)\\b', color: 'yellow' },
      { keyword: '\\b(ahead of|behind) \\S+ by \\d+ commits?\\b', color: 'cyan' },
      { keyword: '\\bon branch \\S+', color: 'green' },
      { keyword: '\\b(Merge branch|Merge pull request|Merge remote-tracking branch|Merge tag)\\b', color: 'cyan' },
      // 分支/远端引用：origin|upstream 那条是这条的子集，删掉重复的一条
      { keyword: '\\b(HEAD|FETCH_HEAD|ORIG_HEAD|origin|upstream|main|master|develop|trunk|staging|production|release)/[\\w./-]+\\b', color: 'blue' },
      // commit id：带前缀的和裸 40 位合并成一条 magenta
      { keyword: '\\bcommit [0-9a-f]{7,40}\\b|\\b[0-9a-f]{40}\\b', color: 'magenta' },
      { keyword: '\\bindex [0-9a-f]{7,}\\.\\.[0-9a-f]{7,}( \\d+)?\\b', color: 'magenta' },
      { keyword: '@@ -\\d+(,\\d+)? \\+\\d+(,\\d+)? @@', color: 'cyan' },
      // diff 头与 +++/--- 文件头：两条同色 blue，合成一条
      { keyword: '\\bdiff --(git|stat)\\b|(?<!\\S)(\\+\\+\\+|---) [ab]/\\S+', color: 'blue' },
      rule.srcFile
    ]
  },
  {
    name: 'Auth & security',
    description: 'sshd, sudo, PAM, fail2ban, nftables/iptables and TLS handshake output: logins, authentication failures, permission denials, blocked and allowed connections, key fingerprints',
    keywords: [
      { keyword: '\\b(failed password|authentication failure|auth(entication)? fail(ed|ure)?|invalid user|permission denied|access denied|not allowed|unauthorized|forbidden|break-in|refused|reject(ed)?|denied|dropped|blocked|banned|revoked|expired|certificate (has )?expired|self[- ]signed|unable to authenticate|too many authentication failures|connection closed by authenticating user|possible break-in attempt)\\b', color: 'red' },
      { keyword: '\\b(Accepted (password|publickey|keyboard-interactive|none|gssapi[\\w-]*)|session opened|session closed|successful(ly)?|logged in|login successful|authenticated|granted|new session|established|reverse mapping checking .* successful|COMMAND=)\\b', color: 'green' },
      { keyword: '\\b(warning|deprecated|weak|insecure|legacy|retrying|attempt|partial|unknown key|reverse mapping|not permitted|no matching host key)\\b', color: 'yellow' },
      { keyword: '\\b(DROP|REJECT|ACCEPT|DNAT|SNAT|MASQUERADE)\\b', color: 'magenta' },
      { keyword: '\\b(sshd|sudo|pam_[a-z]+|fail2ban|nft|iptables|firewalld|ufw|polkit|openssl|openssh|gssapi)\\b', color: 'blue' },
      // user names only where the surrounding words make it unambiguous
      { keyword: '(?<=\\buser )[a-z_][a-z0-9_-]*\\b|(?<=\\bfor )[a-z_][a-z0-9_-]*(?= from )', color: 'blue' },
      { keyword: '\\bport \\d{1,5}\\b', color: 'magenta' },
      { keyword: '\\b(SHA256:[A-Za-z0-9+/]{43}=?|MD5:[0-9a-f]{2}(:[0-9a-f]{2}){15})', color: 'magenta' },
      { keyword: '\\b(TLSv1(\\.[0-3])?|SSLv3|TLS_AES_\\w+|ECDHE[\\w-]*|cipher|handshake|verify (returned|ok|error)|Cipher is)\\b', color: 'cyan' },
      { keyword: '(?<![\\w])(/(?:etc|var|home|root|usr|opt|tmp|srv|run|proc|sys|dev)/[\\w./-]*)', color: 'blue' },
      rule.ipv4,
      rule.ipv6
    ]
  },
  {
    // 数据库分组：既覆盖终端里跑 mysql/psql/redis-cli 的回显，也覆盖数据库页
    // 表格单元格里的值（两处用的是同一份 config.keywords，见 db-highlight.jsx）。
    // 刻意不加「裸数字」规则：规则是各自独立的正则，同一位置命中的更短匹配会
    // 先于更长匹配胜出，裸数字会把时间戳/IP 这类从数字开始的规则整段挤掉。
    name: 'Database & SQL',
    description: 'SQL statements and mysql, psql and redis-cli output, plus the values a result grid renders: statement keywords, NULL and booleans, quoted identifiers, error codes and SQLSTATE, status lines, timestamps, UUIDs, hex and bytea blobs',
    keywords: [
      // SQL 语句关键词合成一条规则：同一条规则内按备选顺序命中，
      // 多词形式必须排在其单词形式之前（GROUP BY 要在 GROUP 之前）
      { keyword: '\\b(GROUP BY|ORDER BY|PRIMARY KEY|FOREIGN KEY|IF NOT EXISTS|IF EXISTS|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMIT|ROLLBACK|SAVEPOINT|EXPLAIN|ANALYZE|VACUUM|MERGE|UPSERT|RETURNING|JOIN|UNION|INTERSECT|EXCEPT|DISTINCT|VALUES|WHERE|HAVING|LIMIT|OFFSET|REFERENCES|CONSTRAINT|CASCADE|RESTRICT|LIKE|ILIKE|BETWEEN|FROM|SET|INTO|TABLE|VIEW|INDEX|SEQUENCE|TRIGGER|PROCEDURE|FUNCTION|DATABASE|SCHEMA)\\b', color: 'blue' },
      // 引用标识符：MySQL 反引号 `db`.`table`、PostgreSQL 双引号 "schema"."table"
      // 双引号只认「单段标识符」，避免把普通字符串值 "hello world" 也算进来
      { keyword: '`[^`\\n]{1,64}`|"[A-Za-z_][\\w$]*"(?:\\."(?:[A-Za-z_][\\w$]*|\\*)")*', color: 'blue' },
      rule.nullBool,
      // 报错：severity、MySQL 错误码/错误名、PostgreSQL SQLSTATE
      { keyword: '\\b(ERROR|ER_[A-Z0-9_]+|SQLSTATE|FATAL|PANIC|DEADLOCK|DEADLOCK DETECTED|duplicate (key|entry|column)|already exists|does not exist|unknown (column|table|database|relation)|access denied|connection (refused|reset)|too many connections|lock wait timeout|syntax error|violates (check|unique|foreign key) constraint)\\b', color: 'red' },
      // Redis 错误回复
      { keyword: '\\((error)\\)|\\b(WRONGTYPE|NOSCRIPT|NOAUTH|NOPERM|EXECABORT|CROSSSLOT|MOVED|CLUSTERDOWN|MASTERDOWN|READONLY|MISCONF|BUSYGROUP|OOM command not allowed)\\b', color: 'red' },
      // Redis 类型标记：(integer) (nil) (empty array) …
      { keyword: '\\((integer|double|boolean|nil|empty array|empty list|empty set)\\)', color: 'magenta' },
      // 状态行：MySQL「Query OK / 3 rows affected / 1 row in set」、psql「(3 rows)」、Redis「PONG」
      { keyword: '\\b(Query OK|Empty set|rows? affected|rows? matched|rows? returned|in set|PONG|QUEUED)\\b|\\(\\d+ rows?\\)', color: 'green' },
      // 耗时：MySQL/psql 结尾的 (0.01 sec)
      { keyword: '\\(\\d+(?:\\.\\d+)? ?(?:sec|ms|min)\\)', color: 'cyan' },
      // 警告与执行计划里的性能提示
      { keyword: '\\b(WARNING|NOTICE|DEPRECATED|slow query|Using filesort|Using temporary|full table scan|seq scan|connection is read-only)\\b', color: 'yellow' },
      // 时间戳复用共享写法（已带 JSON 边界排除）
      rule.ts,
      // UUID、十六进制字面量（0x… 与 PostgreSQL bytea 的 \x…，同色合并成一条）
      { keyword: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', color: 'magenta' },
      { keyword: '\\b0x[0-9a-f]{2,}\\b|\\\\x[0-9a-f]{2,}', color: 'magenta' },
      // 体积/字节数：SHOW TABLE STATUS、pg_total_relation_size 等
      rule.size,
      // SHOW PROCESSLIST / pg_stat_activity 里的来源主机
      rule.ipv4
    ]
  }
]

// Append a preset's rules to existing keywords, skipping duplicates and the
// empty placeholder row the settings form starts with.
export function mergeKeywordPreset (existing = [], preset) {
  const kept = existing.filter(k => k && k.keyword)
  const seen = new Set(kept.map(k => k.keyword))
  const added = preset.keywords.filter(k => !seen.has(k.keyword))
  return [...kept, ...added.map(k => ({ ...k }))]
}
