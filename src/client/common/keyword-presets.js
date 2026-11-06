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
 *   - WindTerm ships a default highlight scheme per connection type inside the
 *     app bundle; the Linux one is terminal/schemes/linux/linux.lexer with the
 *     colours coming from global/themes/<theme>/scheme.theme. It is the closest
 *     thing to a drop-in general-purpose set, so its categories are mirrored
 *     rather than copied.
 * They are per-command shell wrappers or editor grammars, and none of them
 * uses ANSI colour names, so these presets follow their categories rather
 * than their files.
 *
 * ## V2 整理纪律（2026-11-05 定稿）
 *
 * 1. **一条正则全仓只出现一次（跨组唯一）**。原来共享规则（IP、时间戳、路径…）
 *    被多个业务组各自引用同一个 `rule.*` 对象，靠 `mergeKeywordPreset` 去重压成
 *     "生效条数 < 面板条目数"，面板「已应用 N/M」和实际着色对不上。现在所有共享
 *     形状收进下面三个「通用 · *」组，业务组只留领域独有规则，靠 `requires`
 *     把依赖的通用档一起点亮——规则仍全仓只存一份，满足「共享的也不行」。
 * 2. **共享规则的配色在定义处钉死**。跨组唯一后同正则同色由结构保证，不再依赖去重。
 * 3. **同色 + 同类才合并成一条备选式**（如 ts+tsBracket、ipv6+mac、absPath+srcFile、
 *    dur+durKey），且保持原有先后顺序；不同色绝不合并（那是预设要表达的区别）。
 * 4. **每条规则按「全部预设同时勾选」的最坏情况计成本**，但现在结构档（时间戳/
 *    数值/地址/路径）默认不进全选，密度由 §7 覆盖率闸治理。
 *
 * 三处「让位护栏」（ipv4 的 (?!:\d)、ts 的 (?!\.\d)、lvlError 的 DOES NOT(?:…)、
 * num 的 (?<!status[=:]\s{0,2})、Docker 镜像的 (?![\w.-])）是家族不唯一时代的产物。
 * 批次 A 把裁决统一成「最左起点 → rank 小者胜 → 同 rank 取更长 → 等长取原序」
 * （见 common/keyword-scan.js 的 arbitrateAt / selectByRank）后，同起点竞争已由
 * rank 决定，护栏不再是必需；本批次按「不改正则」的纪律全部保留，删除排在批次 C
 * （连同 IPv4/端口家族边界一起做，见 doc/设计-关键字高亮色板与密度-v3-2026-11-06.md §5、§6）。
 */

// ---- 共享片段（全仓只在此定义一次）----
const ipv4 = '\\b(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}(/\\d{1,2})?\\b(?!:\\d)'
const ipv6 = '(?<![\\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?::[0-9a-f]{1,4}){1,7}|::)(?![\\w:])'
const mac = '\\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b|\\b[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}\\b'
const srcExt = 'c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|go|rs|java|kt|kts|scala|ts|tsx|js|jsx|mjs|cjs|py|pyi|rb|php|cs|swift|zig|lua|pl|pm|ex|exs|erl|dart|sh|bash|zsh|ps1|sql|json|ya?ml|toml|ini|cfg|conf|properties|styl|css|scss|sass|less|html|vue|svelte|md|txt|log|csv|tsv'
const srcFile = '\\b[\\w./~-]+\\.(' + srcExt + ')\\b'
const srcLoc = '\\b[\\w./~-]+\\.(' + srcExt + ')\\b(:\\d+){1,2}'

// 时间戳（ISO 8601 / BSD syslog / 时钟）+ 方括号里的时间戳（nginx/dmesg/测试框架）
const ts = '(?<![":])\\b(?:\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?(?:Z|[+-]\\d{2}:?\\d{2})?' +
  '|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?' +
  '|\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d{1,6})?)?(?!\\.\\d))\\b(?![":])'
const tsBracket = '\\[\\d{2}/\\w{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4}\\]|\\[\\s*\\d+\\.\\d+\\]|\\[\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?\\]'
const tsAll = tsBracket + '|' + ts

// 时长与体积共用的单位表（长单位排在单字母之前）
const unitTime = 'ns|us|µs|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|[smh]'
const unitSize = 'bytes?|[KMGTPE]i?B|[KMGTPE]'

const dur = '\\b\\d+(?:\\.\\d+)?\\s?(?:' + unitTime + ')\\b'
// 时长：key=value 形式（单位必须是真实单位词，不能写成「任意 1-6 个字母」）
const durKey = '\\b(?:request_time|upstream_response_time|request_time_ms|duration|latency|elapsed|took|wall ?time)(?:[=:]\\s*|\\s+)\\d+(?:\\.\\d+)?(?:\\s?(?:' + unitTime + ')\\b)?'
const durAll = dur + '|' + durKey

// 体积与吞吐
const size = '\\b\\d+(?:\\.\\d+)?\\s?(?:' + unitSize + ')(?:/s)?\\b'

// PCI / 设备地址（内核组独有，见 §6.2；不进通用档）
const devAddr = '\\b(?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\\.\\d\\b|\\b[0-9a-f]{4}:[0-9a-f]{4}\\b'

// 日志级别与泛用报错词（红档一条打尽）
const lvlError = '\\b(?:EMERG(?:ENCY)?|ALERT|CRITICAL|CRIT|SEVERE|FATAL|PANIC(?:KED)?|' +
  'ERRORS?|ERR|EXCEPTIONS?|CAUSED BY|' +
  'FAIL(?:ED|ING|URE|URES)?|DENIED|DENY|REFUSED|REJECTED|TIMEOUT|TIMED OUT|UNREACHABLE|' +
  'CORRUPT(?:ED|ION)?|SEGFAULT|SEGMENTATION FAULT|CORE[- ]DUMP(?:ED|ING)?|DROPPED|' +
  'ABORT(?:ED|ING)?|CRASH(?:ED|ING|ES)?|EXPIRED|REVOKED|VULNERABILIT(?:Y|IES)|' +
  'BAD|INCORRECT|INVALID|UNSUPPORTED|WRONG|MISMATCH|MISCONFIGURED|MISSING|' +
  'UNEXPECTED|UNAVAILABLE|UNRESOLVED|' +
  'CANNOT|CAN NOT|COULD ?NOT|SHOULD ?NOT|WOULD ?NOT|WILL ?NOT|DOES NOT(?: (?:EXIST|MATCH))?|DID NOT|' +
  "CAN'T|COULDN'T|SHOULDN'T|WOULDN'T|WON'T|DIDN'T|DOESN'T|" +
  'NOT (?:FOUND|ALLOWED|PERMITTED|AVAILABLE|SUPPORTED|RESPONDING|AUTHENTICATED|' +
  'INITIALIZED|ESTABLISHED|REACHABLE|VALID)|' +
  'NO SUCH \\w+|NO (?:ROUTE|PERMISSIONS?|RESPONSE|SPACE|MATCHING|ACCESS|AUTHENTICATION)|' +
  'UNDEFINED (?:REFERENCE|SYMBOL)|PERMISSION DENIED|EACCES|ENOENT)\\b|(?:✗|✘|✖)'
const lvlWarn = '\\b(?:WARN(?:ING)?S?|DEPRECATED|DEPRECATION|OUTDATED|HINT|DISABLED|UNKNOWN|INCOMPATIBLE|LEGACY)\\b'
const lvlInfo = '\\bINFO(?:RMATION|RMATIONAL)?\\b'
const lvlDebug = '\\b(?:DEBUG|TRACE|VERBOSE)\\b'

// 异常类名
const exc = '\\b(?:[\\w$]+\\.)*[A-Z][\\w$]*(?:Error|Exception|Throwable|Fault|Panic)\\b'

// NULL 与布尔
const nullBool = '(?<![\\w"])\\b(?:NULL|NIL|NONE|UNDEFINED|NaN|TRUE|FALSE)\\b'

// 「这就是一次成功」的词
const wordOk = '\\b(?:OK|ALL OK|YES|SUCCESS(?:FUL(?:LY)?)?|PASSED|PASSES|VALID|VALIDATED|' +
  'CORRECT(?:LY)?|SUPPORTED|KNOWN|VERIFIED|RESOLVED|ENABLED|AVAILABLE|REACHABLE|' +
  'COMPLETE(?:D)?|FINISHED|SUCCEEDED|WORKING|NORMAL|STABLE|CONNECTED|READY|' +
  'ACCEPT(?:ED)?|GRANTED|CLEAN|UP TO DATE)\\b'

// 裸数字（边界比 WindTerm 严，挡住各类抢占）
const num = '(?<![\\w.~/-])(?<!\\d:)(?<!"\\s)(?<!status[=:]\\s{0,2})\\d+(?:\\.\\d+)?%?' +
  '(?![\\w~/:-])(?!\\.\\d)(?!\\s*\\(\\d+[dhms])' +
  '(?!\\s?(?:' + unitSize + ')(?:/s)?\\b)(?!\\s?(?:' + unitTime + ')\\b)'

// 十六进制字面量（含 PostgreSQL bytea 的 \x…）
const hex = '\\b0x[0-9a-f]{2,}\\b|\\\\x[0-9a-f]{2,}'

// 命令行选项
const optFlag = '(?<![\\w/~-])-{1,2}[A-Za-z][\\w]*(?:-[A-Za-z][\\w]*)*(?:=[^\\s,;)]*)?(?![-\\w])'

// 绝对路径
const absPath = '(?<![\\w/])(?:/(?:etc|var|home|root|usr|opt|tmp|srv|run|proc|sys|dev|bin|sbin|lib|lib64|mnt|media|config)(?![\\w-])(?:/[\\w.@+~/-]*)?|/[\\w.@+~-]{2,}(?:/[\\w.@+~-]*)*/?)'
// 路径 = 绝对路径 + 源文件名（同蓝，合成一条）
const pathAll = absPath + '|' + srcFile
// 地址 = IPv6 + MAC（同紫，合成一条）
const addr6 = ipv6 + '|' + mac
// URL（协议开头的绝对链接）
const url = '\\bhttps?://[^\\s"\']+'

// ---- 三个通用组：任何输出里都会出现的形状，全仓只存一份 ----
const sigC = 'cyan'
const sigB = 'blue'
const sigM = 'magenta'

// 注：规则上的 tier 是 §7 密度治理的开关粒度。通用结构档默认不进全选，
// 业务组里的「领域名词/地址/ID」类也标 structure，错误/状态/冲突词标 signal。
/* ------------------------------------------------------------------ *
 * V3 信号家族契约（doc/设计-关键字高亮色板与密度-v3-2026-11-06.md §3）
 *
 * 每条规则必须声明 family；一个 family = 一种颜色 = 一个归属组 = 一个 rank。
 * 重叠裁决按「最左起点 → rank 小者胜 → 同 rank 取更长 → 等长取原序」，
 * 不再用「同起点取最短 + 让位 lookahead」——那是家族不唯一时的权宜。
 *
 * FAMILY_RANK 是发布契约：新增家族必须同时登记 rank，否则 keyword-family.spec.js 失败。
 * ------------------------------------------------------------------ */
export const FAMILY_RANK = {
  // 0 · marker — 边界记号：冲突标记、diff 头/块、Redis 类型标记——先于一切形状，否则被路径/数字吃掉
  'conflict-marker': 0, 'diff-header': 0, 'diff-hunk': 0, 'diff-index': 0, 'redis-type': 0,
  // 10 · exact-addr — 精确地址：IP / IPv6+MAC / URL / UUID / 指纹 / PCI——长度确定、误染代价最高
  'fingerprint': 10, 'ipv4': 10, 'ipv6-mac': 10, 'pci-address': 10, 'url': 10, 'uuid': 10,
  // 20 · path — 路径与位置：绝对路径、源文件、file:line、栈帧
  'file-line': 20, 'path': 20, 'py-file-line': 20, 'stack-frame': 20,
  // 30 · domain-id — 领域标识：接口名、unit、设备、资源引用、镜像、git ref、SQL 关键词…
  'ahead-behind': 30, 'auth-daemon': 30, 'branch-line': 30, 'commit-sha': 30, 'daemon-tag': 30, 'device-name': 30, 'field-name': 30, 'git-ref': 30, 'http-method': 30, 'image-ref': 30, 'interface-name': 30, 'kernel-version': 30, 'merge-line': 30, 'nft-target': 30, 'pid': 30, 'pod-name': 30, 'quoted-ident': 30, 'resource-ref': 30, 'signal-name': 30, 'sql-keyword': 30, 'thread-name': 30, 'tls-word': 30, 'trace-id': 30, 'unit-name': 30, 'user-agent': 30, 'username': 30,
  // 40 · num-time — 时间与数值：时间戳、时长、体积、百分比、端口、hex、命令行选项
  'cli-flag': 40, 'duration': 40, 'hex-literal': 40, 'host-port': 40, 'percent': 40, 'port-map': 40, 'port-word': 40, 'restart-count': 40, 'size': 40, 'timestamp': 40,
  // 50 · signal-word — 状态词：报错/警告/成功/跳过/异常类名/NULL——任何领域都同色，靠 rank 不被结构档抢
  'build-verb': 50, 'exception-class': 50, 'null-bool': 50, 'traceback-head': 50, 'word-debug': 50, 'word-error': 50, 'word-info': 50, 'word-ok': 50, 'word-skip': 50, 'word-warn': 50,
  // 55 · signal-grade — 分级族：按级别分色的族（HTTP 状态码、syslog severity、nginx 方括号级别）
  'bracket-level.err': 55, 'bracket-level.info': 55, 'bracket-level.warn': 55, 'http-status.1xx2xx': 55, 'http-status.3xx': 55, 'http-status.4xx': 55, 'http-status.5xx': 55, 'syslog-sev.err': 55, 'syslog-sev.info': 55, 'syslog-sev.warn': 55,
  // 60 · loose — 宽口径兜底：裸数字、包名/域名——只在没有更精确的族命中时染
  'number': 60, 'package-name': 60
}

// rank 层级表（供设置面板与测试展示"这个信号属于哪一层"）
export const FAMILY_LAYERS = { 'marker':0,'exact-addr':10,'path':20,'domain-id':30,'num-time':40,'signal-word':50,'signal-grade':55,'loose':60 }

export const keywordPresets = [
  {
    name: '通用 · 级别与状态',
    tier: 'signal',
    description: '任何日志都会出现的结构类以外的语义信号：报错/失败词、告警、信息、调试、成功、异常类名、NULL/布尔。勾选业务组会自动连带点亮。',
    keywords: [
      { keyword: lvlError, color: 'red', tier: 'signal', family: 'word-error' },
      { keyword: lvlWarn, color: 'yellow', tier: 'signal', family: 'word-warn' },
      { keyword: lvlInfo, color: sigC, tier: 'signal', family: 'word-info' },
      { keyword: lvlDebug, color: sigB, tier: 'signal', family: 'word-debug' },
      { keyword: wordOk, color: 'green', tier: 'signal', family: 'word-ok' },
      { keyword: exc, color: 'red', tier: 'signal', family: 'exception-class' },
      { keyword: nullBool, color: sigM, tier: 'signal', family: 'null-bool' }
    ]
  },
  {
    name: '通用 · 时间与数值',
    tier: 'structure',
    description: '全仓最吵的结构档：时间戳、时长、体积、裸数字、十六进制、命令行选项。默认不进「全部应用」，按行覆盖率闸之后才出现。',
    keywords: [
      { keyword: tsAll, color: '#56D4FF', tier: 'structure', family: 'timestamp' },
      { keyword: durAll, color: '#2DD4BF', tier: 'structure', family: 'duration' },
      { keyword: size, color: '#A5D6FF', tier: 'structure', family: 'size' },
      { keyword: num, color: '#79C0FF', tier: 'structure', family: 'number' },
      { keyword: hex, color: '#D2A8FF', tier: 'structure', family: 'hex-literal' },
      { keyword: optFlag, color: '#E3B341', tier: 'structure', family: 'cli-flag' }
    ]
  },
  {
    name: '通用 · 地址与路径',
    tier: 'structure',
    description: '全仓最吵的结构档：IP、IPv6/MAC、绝对路径/源文件名、文件:行、URL。默认不进「全部应用」。',
    keywords: [
      { keyword: ipv4, color: '#FF9ECB', tier: 'structure', family: 'ipv4' },
      { keyword: addr6, color: '#FF7BAC', tier: 'structure', family: 'ipv6-mac' },
      { keyword: pathAll, color: '#9CDCFE', tier: 'structure', family: 'path' },
      { keyword: srcLoc, color: '#7EE787', tier: 'structure', family: 'file-line' },
      { keyword: url, color: '#F78C6C', tier: 'structure', family: 'url' }
    ]
  },

  // ---- 业务组：只留领域独有规则，靠 requires 连带通用档 ----
  {
    name: 'Networking',
    requires: ['通用 · 地址与路径'],
    description: 'Switch and router CLI output (Cisco, Juniper, Arista, HPE Aruba and Comware, Huawei, Ubiquiti EdgeOS, MikroTik, Hirschmann, Moxa and similar): link state, errors, syslog severity, IPs, MACs, interfaces',
    keywords: [
      // syslog severity: %FACILITY-<severity>-MNEMONIC
      { keyword: '%[A-Z0-9_]+-[0-3]-[A-Z0-9_]+', color: 'red', tier: 'signal', family: 'syslog-sev.err' },
      { keyword: '%[A-Z0-9_]+-4-[A-Z0-9_]+', color: 'yellow', tier: 'signal', family: 'syslog-sev.warn' },
      { keyword: '%[A-Z0-9_]+-[5-7]-[A-Z0-9_]+', color: sigC, tier: 'signal', family: 'syslog-sev.info' },
      // link / port state
      { keyword: '\\b(administratively down|err-?disabled|notconnect|not connected|link down|down|adm)\\b|\\b[Au]/D\\b', color: 'red', tier: 'signal', family: 'word-error' },
      // 交换机/控制器私有报错词表（带 JSON 边界排除，键名不染）
      { keyword: '(?<![":])\\b(errors?|fail(ed|ure|s)?|denied|deny|invalid|incomplete|unreachable|timeout|timed out|crc|runts|giants|collisions?|input errors|output errors|discard(s|ed)?|drop(s|ped)?|blocking|blk|bkn|broken|alarm|critical|access denied)\\b(?![":])', color: 'red', tier: 'signal', family: 'word-error' },
      { keyword: '(?<![":])\\b(up|connected|link up|permit(ted)?|forwarding|fwd|full|established|active|success(ful)?|enabled?|ok|online|reachable|root)\\b(?![":])(?!\\s+\\d+\\s+(?:second|minute|hour|day|week|month|year)s?)|\\bu/u\\b', color: 'green', tier: 'signal', family: 'word-ok' },
      { keyword: '(?<![":])\\b(warning|warn|half|learning|lrn|listening|lis|standby|disabled?|shutdown|pending|unknown|desg|altn|alternate|backup)\\b(?![":])', color: 'yellow', tier: 'signal', family: 'word-warn' },
      // 接口名（多厂商，同蓝）
      { keyword: '\\b(GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|XGigabitEthernet|FastEthernet|Ethernet|Eth-Trunk|Port-channel|Bridge-Aggregation|Route-Aggregation|Management|Loopback|Tunnel|MEth|Vlanif|Vlan|BAGG|sfp-sfpplus|sfp|ether|switch|bridge|bond|wlan|pppoe|Trk|ae|br|XGE|FGE|GE|Gi|Te|Twe|Fo|Hu|Fa|Eth|Et|Ma|Po|Lo|Tu|Vl|\\d{2,3}GE)\\s?\\d+(/\\d+){0,3}(\\.\\d+)?\\b|\\b(ge|xe|et|fe|mge|lt|gr)-\\d+/\\d+/\\d+(\\.\\d+)?\\b|\\birb(\\.\\d+)?\\b|\\b(em|fxp|me)\\d+\\b|\\b(cpu|vlan|lag|ch)\\s?/?\\d+(/\\d+)?\\b|(?<![\\w./])\\d/\\d{1,2}(/\\d{1,2})?\\b', color: sigB, tier: 'structure', family: 'interface-name' }
    ]
  },
  {
    name: 'Syslog & systemd',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'journalctl, /var/log/syslog and messages, systemd unit output: severity, unit lifecycle states, unit names, timestamps, PIDs',
    keywords: [
      // unit lifecycle（failed 已由通用红档覆盖）
      { keyword: '\\b(dead|inactive|killed|masked)\\b', color: 'red', tier: 'signal', family: 'word-error' },
      { keyword: '\\b(started|starting|active|running|reached|succeeded|success(fully)?|listening|mounted|finished|enabled)\\b', color: 'green', tier: 'signal', family: 'word-ok' },
      { keyword: '\\b(stopping|stopped|reloading|reload(ed)?|deactivating|activating|waiting|pending|scheduled|restart(ing|ed)?|retrying|degraded)\\b', color: 'yellow', tier: 'signal', family: 'word-warn' },
      // unit names
      { keyword: '\\b[a-z0-9][a-z0-9@._-]*\\.(service|socket|target|timer|mount|automount|device|path|slice|scope|swap)\\b', color: sigB, tier: 'structure', family: 'unit-name' },
      { keyword: '\\b(pid|PID)[= ]\\d+\\b', color: sigM, tier: 'structure', family: 'pid' },
      { keyword: '\\b(sshd|sudo|systemd|crond?|dbus-daemon|NetworkManager|polkitd|rsyslogd|logind|kernel)\\[[0-9]+\\]', color: sigB, tier: 'structure', family: 'daemon-tag' }
    ]
  },
  {
    name: 'Linux kernel & dmesg',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值'],
    description: 'dmesg, the kernel ring buffer and boot messages: OOM killer, segfaults, hardware and I/O errors, device, link and driver events',
    keywords: [
      { keyword: '\\b(kernel panic|general protection fault|unable to handle (kernel )?paging request|segfault|out of memory|oom[- ]kill(er)?|killed process|call trace|hardware error|machine check|medium error|unrecoverable (read|error)|i/o error|buffer i/o error|ext4-fs error|xfs .*corruption|reset .* failed|device not ready|link is not ready|firmware (bug|error)|stack corruption|bad rip value|blocked for more than)\\b', color: 'red', tier: 'signal', family: 'word-error' },
      { keyword: '\\b(falling back|retry(ing)?|deferred|link is down|disconnected|removed|suspended|unstable|degraded|overcurrent|throttl(ed|ing)|thermal|under-voltage|over-voltage)\\b', color: 'yellow', tier: 'signal', family: 'word-warn' },
      { keyword: '\\b(link is up|link up|registered|initialized|attached|mounted|enabled|detected|ready|success(ful)?|started|inserted|now attached|power on|resumed|link becomes ready)\\b', color: 'green', tier: 'signal', family: 'word-ok' },
      // device names
      { keyword: '\\b(ata\\d+(\\.\\d+)?|sd[a-z]\\d*|nvme\\d+n\\d+(p\\d+)?|mmcblk\\d+(p\\d+)?|dm-\\d+|md\\d+|eth\\d+|wlan\\d+|enp\\d+s\\d+|eno\\d+|wlp\\d+s\\d+|usb \\d+-\\d+(\\.\\d+)?|tty(S|USB|ACM)\\d+|br-\\d+|veth[0-9a-f]+)\\b', color: sigB, tier: 'structure', family: 'device-name' },
      // devAddr 归内核组独有（PCI 地址 / WWN）
      { keyword: devAddr, color: sigM, tier: 'structure', family: 'pci-address' },
      { keyword: '\\bLinux version \\S+\\b', color: sigC, tier: 'structure', family: 'kernel-version' }
    ]
  },
  {
    name: 'HTTP & web logs',
    requires: ['通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'nginx and Apache access and error logs, and most web framework request logs: methods, status codes by class, latency, upstream hosts, user agents, paths',
    keywords: [
      // 状态码按类分色（裸三位数字不误染）
      { keyword: '(?:(?<="\\s)|\\bstatus[=:]\\s*)5\\d{2}\\b', color: 'red', tier: 'signal', family: 'http-status.5xx' },
      { keyword: '(?:(?<="\\s)|\\bstatus[=:]\\s*)4\\d{2}\\b', color: 'yellow', tier: 'signal', family: 'http-status.4xx' },
      { keyword: '(?<="\\s)3\\d{2}\\b', color: sigC, tier: 'signal', family: 'http-status.3xx' },
      { keyword: '(?<="\\s)[12]\\d{2}\\b', color: 'green', tier: 'signal', family: 'http-status.1xx2xx' },
      // 请求行 + 协议版本（host:port 与裸 URL 交给通用档）
      { keyword: '\\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\\s+\\S+\\s+HTTP/|\\bHTTP/\\d(?:\\.\\d)?', color: sigB, tier: 'structure', family: 'http-method' },
      { keyword: '\\bupstream\\b', color: sigM, tier: 'signal', family: 'field-name' },
      // host:port（非时间戳里的 08:57）
      { keyword: '\\b(?:[a-z][a-z0-9.-]*|\\d{1,3}(?:\\.\\d{1,3}){3}):\\d{2,5}(?:->\\d{1,5}/(?:tcp|udp))?\\b', color: sigM, tier: 'structure', family: 'host-port' },
      { keyword: '\\b(Mozilla/5\\.0|curl/\\S+|Wget/\\S+|Googlebot(?:/\\S+)?|bingbot(?:/\\S+)?|python-requests/\\S+|Go-http-client/\\S+|okhttp/\\S+|PostmanRuntime/\\S+|Apache-HttpClient/\\S+|axios/\\S+|node-fetch/\\S+|Electron/\\S+)\\b', color: sigM, tier: 'structure', family: 'user-agent' },
      // error-log 的级别（[module:level]）
      { keyword: '\\[[\\w.:-]*(?:EMERG|ALERT|CRIT(?:ICAL)?|ERROR|ERR)\\]', color: 'red', tier: 'signal', family: 'bracket-level.err' },
      { keyword: '\\[[\\w.:-]*(?:WARN(?:ING)?|NOTICE)\\]', color: 'yellow', tier: 'signal', family: 'bracket-level.warn' },
      { keyword: '\\[[\\w.:-]*(?:INFO|DEBUG)\\]', color: sigC, tier: 'signal', family: 'bracket-level.info' }
    ]
  },
  {
    name: 'Application log levels',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'Generic application logs (log4j/slf4j, Python logging, Go slog, Rust tracing, Node winston/pino): levels, timestamps, thread and logger names, exception types, tracing ids',
    keywords: [
      // tracing / correlation ids, in "k=v" and in JSON "k": "v" form
      { keyword: '\\b(trace_?id|span_?id|request_?id|correlation_?id|session_?id|user_?id)["\']?\\s*[=:]\\s*["\']?[\\w.:-]+', color: sigM, tier: 'structure', family: 'trace-id' },
      // logger / package names: com.example.Foo, my.pkg.module
      { keyword: '\\b([A-Za-z_][A-Za-z0-9_]*\\.){2,}[A-Za-z_][A-Za-z0-9_]*\\b', color: sigB, tier: 'structure', family: 'package-name' },
      // thread names: [main], [worker-3], [pool-2-thread-1]
      { keyword: '\\[(main|worker[- ]?\\d+|pool-\\d+-thread-\\d+|Thread-\\d+|goroutine \\d+|[A-Za-z0-9_-]{1,20}-\\d+)\\]', color: sigB, tier: 'structure', family: 'thread-name' }
    ]
  },
  {
    name: 'Exceptions & Stack Traces',
    requires: ['通用 · 级别与状态'],
    description: 'Java/Python/Go crash signatures: exception classes, Caused by chains, at frames, Traceback blocks, native signal aborts and panic lines',
    keywords: [
      { keyword: '\\bat [\\w$.]+\\([^)]*\\)', color: sigB, tier: 'structure', family: 'stack-frame' },
      // Python 栈头整句（含括号）
      { keyword: 'Traceback \\(most recent call last\\)|\\bstack ?trace\\b', color: 'red', tier: 'signal', family: 'traceback-head' },
      { keyword: 'File "[^"]+", line \\d+', color: 'yellow', tier: 'signal', family: 'py-file-line' },
      { keyword: '\\b(SIGSEGV|SIGABRT|SIGKILL)\\b', color: 'red', tier: 'signal', family: 'signal-name' }
    ]
  },
  {
    name: 'Docker & Kubernetes',
    requires: ['通用 · 级别与状态', '通用 · 地址与路径'],
    description: 'docker ps/images/compose and kubectl get/describe/logs output: container states, pod phases and events, resource references, image tags and digests, ports, ages, restart counts',
    keywords: [
      { keyword: '\\b(CrashLoopBackOff|ErrImagePull|ImagePullBackOff|CreateContainerConfigError|CreateContainerError|InvalidImageName|OOMKilled|Evicted|Failed|FailedScheduling|Error|BackOff|Unhealthy|Dead|Removing|NotReady|Terminating|NoSchedule)\\b|\\bExited \\([1-9]\\d*\\)', color: 'red', tier: 'signal', family: 'word-error' },
      { keyword: '\\b(Pending|ContainerCreating|Init:\\d+/\\d+|PodInitializing|Waiting|SchedulingDisabled|Unknown|Paused|Restarting|Preempting|Warning)\\b', color: 'yellow', tier: 'signal', family: 'word-warn' },
      { keyword: '\\b(Running|Ready|Healthy|Active|Bound|Started|Pulled|Created|Available|Deployed|Completed|Succeeded|Up \\d+ (second|minute|hour|day|week|month|year)s?)\\b|\\bExited \\(0\\)', color: 'green', tier: 'signal', family: 'word-ok' },
      // resource references: deployment/nginx, pods/nginx-1, svc/api
      { keyword: '\\b(pods?|deploy(ment)?s?|svc|services?|ingress(es)?|configmaps?|secrets?|statefulsets?|daemonsets?|replicasets?|jobs?|cronjobs?|namespaces?|nodes?|pv|pvc|endpoints?|hpa|events?)/[a-z0-9][a-z0-9.-]*\\b', color: sigB, tier: 'structure', family: 'resource-ref' },
      // generated pod / container names: nginx-7d9f8c6b5-x2k4p
      { keyword: '\\b[a-z0-9][a-z0-9-]*-[0-9a-f]{5,10}-[a-z0-9]{4,6}\\b', color: sigM, tier: 'structure', family: 'pod-name' },
      // AGE column: 12m, 45s, 3d4h
      { keyword: '\\b\\d+[dhms](\\d+[dhms])*\\b', color: '#2DD4BF', tier: 'structure', family: 'duration' },
      // restart counts: "3 (4m ago)"
      { keyword: '\\b\\d+ \\(\\d+[dhms]+ ago\\)', color: sigM, tier: 'structure', family: 'restart-count' },
      // 镜像：常用镜像名（带 tag）、registry 引用、sha256 摘要
      { keyword: '\\b(nginx|redis|postgres|mysql|mariadb|mongo|alpine|ubuntu|debian|busybox|python|golang|openjdk|eclipse-temurin|rabbitmq|kafka|elasticsearch|traefik|haproxy|caddy|vault|consul|etcd|prometheus|grafana|jenkins|gitlab-runner|fluentd|fluent-bit|metrics-server|kube-[a-z-]+)(:[a-zA-Z0-9._-]+)?(?![\\w.-])|\\b[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d+)?/[a-z0-9._/-]+(:[a-zA-Z0-9._-]+)?\\b|\\bsha256:[0-9a-f]{12,64}\\b', color: sigM, tier: 'structure', family: 'image-ref' },
      // ports and port mappings
      { keyword: '\\b\\d{1,5}->\\d{1,5}/(tcp|udp)\\b', color: sigM, tier: 'structure', family: 'port-map' },
      { keyword: '(?<![\\w])(?:0\\.0\\.0\\.0|\\*|::):\\d{1,5}(?:->\\d{1,5}/(?:tcp|udp))?\\b', color: sigM, tier: 'structure', family: 'host-port' }
    ]
  },
  {
    name: 'Build & test output',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'gcc/clang, tsc, eslint, make, maven/gradle, go build and pytest/jest/go test/cargo test: diagnostics, file:line:col locations, pass/fail/skip results, timings',
    keywords: [
      { keyword: '\\b(skip|skipped|pending|todo|xfail|xpass|ignored)\\b', color: 'yellow', tier: 'signal', family: 'word-skip' },
      // 通过/成功（通用 wordOk 已覆盖 ok/success/done/finished 等；这里只保留构建域独有的词）
      { keyword: '\\b(PASS|PASSED|passed|build succeeded|build success(ful)?|compilation complete|compiled successfully|all tests passed)\\b|✔|✓|√', color: 'green', tier: 'signal', family: 'word-ok' },
      { keyword: '\\b(building|compiling|linking|bundling|transpiling|minifying|installing|resolving|downloading|fetching|running|executing|starting|cleaning|caching|packaging|publishing)\\b', color: sigB, tier: 'structure', family: 'build-verb' },
      { keyword: '\\b\\d+(\\.\\d+)?%', color: sigC, tier: 'structure', family: 'percent' }
    ]
  },
  {
    name: 'Git',
    requires: ['通用 · 地址与路径'],
    description: 'git status/log/diff/fetch/push/pull/merge output: branch and tracking state, changed and untracked files, conflicts, commit ids, diff hunks',
    keywords: [
      // 冲突标记优先于普通 conflict 单词
      { keyword: '<{7}|={7}|>{7}', color: 'red', tier: 'signal', family: 'conflict-marker' },
      { keyword: '\\b(conflict|conflicts|both modified|both added|both deleted|deleted by (us|them)|added by (us|them)|unmerged|rejected|non-fast-forward|failed to push|detached HEAD|fatal|error|aborting|aborted|refusing to|would be overwritten|not possible to fast-forward)\\b', color: 'red', tier: 'signal', family: 'word-error' },
      { keyword: '\\b(up[- ]to[- ]date|already up to date|everything up-to-date|fast-forward|nothing to commit|working tree clean|successfully|created|deleted branch|merged|rebase(d)? successfully)\\b', color: 'green', tier: 'signal', family: 'word-ok' },
      { keyword: '\\b(modified|deleted|renamed|copied|untracked|staged|unstaged|diverged|no changes added to commit|changes not staged|changes to be committed)\\b', color: 'yellow', tier: 'signal', family: 'word-warn' },
      { keyword: '\\b(ahead of|behind) \\S+ by \\d+ commits?\\b', color: sigC, tier: 'signal', family: 'ahead-behind' },
      { keyword: '\\bon branch \\S+', color: 'green', tier: 'signal', family: 'branch-line' },
      { keyword: '\\b(Merge branch|Merge pull request|Merge remote-tracking branch|Merge tag)\\b', color: sigC, tier: 'signal', family: 'merge-line' },
      // 分支/远端引用
      { keyword: '\\b(HEAD|FETCH_HEAD|ORIG_HEAD|origin|upstream|main|master|develop|trunk|staging|production|release)/[\\w./-]+\\b', color: sigB, tier: 'structure', family: 'git-ref' },
      // commit id + index
      { keyword: '\\bcommit [0-9a-f]{7,40}\\b|\\b[0-9a-f]{40}\\b', color: sigM, tier: 'structure', family: 'commit-sha' },
      { keyword: '\\bindex [0-9a-f]{7,}\\.\\.[0-9a-f]{7,}( \\d+)?\\b', color: sigM, tier: 'structure', family: 'diff-index' },
      { keyword: '@@ -\\d+(,\\d+)? \\+\\d+(,\\d+)? @@', color: sigC, tier: 'structure', family: 'diff-hunk' },
      // diff 头与 +++/--- 文件头
      { keyword: '\\bdiff --(git|stat)\\b|(?<!\\S)(\\+\\+\\+|---) [ab]/\\S+', color: sigB, tier: 'structure', family: 'diff-header' }
    ]
  },
  {
    name: 'Auth & security',
    requires: ['通用 · 级别与状态', '通用 · 地址与路径'],
    description: 'sshd, sudo, PAM, fail2ban, nftables/iptables and TLS handshake output: logins, authentication failures, permission denials, blocked and allowed connections, key fingerprints',
    keywords: [
      { keyword: '\\b(failed password|authentication failure|auth(entication)? fail(ed|ure)?|invalid user|permission denied|access denied|not allowed|unauthorized|forbidden|break-in|refused|reject(ed)?|denied|dropped|blocked|banned|revoked|expired|certificate (has )?expired|self[- ]signed|unable to authenticate|too many authentication failures|connection closed by authenticating user|possible break-in attempt)\\b', color: 'red', tier: 'signal', family: 'word-error' },
      { keyword: '\\b(Accepted (password|publickey|keyboard-interactive|none|gssapi[\\w-]*)|session opened|session closed|successful(ly)?|logged in|login successful|authenticated|granted|new session|established|reverse mapping checking .* successful|COMMAND=)\\b', color: 'green', tier: 'signal', family: 'word-ok' },
      { keyword: '\\b(weak|insecure|legacy|retrying|attempt|partial|unknown key|reverse mapping|not permitted|no matching host key)\\b', color: 'yellow', tier: 'signal', family: 'word-warn' },
      { keyword: '\\b(DROP|REJECT|ACCEPT|DNAT|SNAT|MASQUERADE)\\b', color: sigM, tier: 'signal', family: 'nft-target' },
      { keyword: '\\b(sshd|sudo|pam_[a-z]+|fail2ban|nft|iptables|firewalld|ufw|polkit|openssl|openssh|gssapi)\\b', color: sigB, tier: 'structure', family: 'auth-daemon' },
      // user names only where the surrounding words make it unambiguous
      { keyword: '(?<=\\buser )[a-z_][a-z0-9_-]*\\b|(?<=\\bfor )[a-z_][a-z0-9_-]*(?= from )', color: sigB, tier: 'structure', family: 'username' },
      { keyword: '\\bport \\d{1,5}\\b', color: sigM, tier: 'structure', family: 'port-word' },
      { keyword: '\\b(SHA256:[A-Za-z0-9+/]{43}=?|MD5:[0-9a-f]{2}(:[0-9a-f]{2}){15})', color: sigM, tier: 'structure', family: 'fingerprint' },
      { keyword: '\\b(TLSv1(\\.[0-3])?|SSLv3|TLS_AES_\\w+|ECDHE[\\w-]*|cipher|handshake|verify (returned|ok|error)|Cipher is)\\b', color: sigC, tier: 'structure', family: 'tls-word' }
    ]
  },
  {
    name: 'Database & SQL',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值'],
    description: 'SQL statements and mysql, psql and redis-cli output, plus the values a result grid renders: statement keywords, NULL and booleans, quoted identifiers, error codes and SQLSTATE, status lines, timestamps, UUIDs, hex and bytea blobs',
    keywords: [
      // SQL 语句关键词合成一条规则
      { keyword: '\\b(GROUP BY|ORDER BY|PRIMARY KEY|FOREIGN KEY|IF NOT EXISTS|IF EXISTS|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMIT|ROLLBACK|SAVEPOINT|EXPLAIN|ANALYZE|VACUUM|MERGE|UPSERT|RETURNING|JOIN|UNION|INTERSECT|EXCEPT|DISTINCT|VALUES|WHERE|HAVING|LIMIT|OFFSET|REFERENCES|CONSTRAINT|CASCADE|RESTRICT|LIKE|ILIKE|BETWEEN|FROM|SET|INTO|TABLE|VIEW|INDEX|SEQUENCE|TRIGGER|PROCEDURE|FUNCTION|DATABASE|SCHEMA)\\b', color: sigB, tier: 'structure', family: 'sql-keyword' },
      // 引用标识符
      { keyword: '`[^`\\n]{1,64}`|"[A-Za-z_][\\w$]*"(?:\\."(?:[A-Za-z_][\\w$]*|\\*)")*', color: sigB, tier: 'structure', family: 'quoted-ident' },
      // 报错
      { keyword: '\\b(ERROR|ER_[A-Z0-9_]+|SQLSTATE|FATAL|PANIC|DEADLOCK|DEADLOCK DETECTED|duplicate (key|entry|column)|already exists|does not exist|unknown (column|table|database|relation)|access denied|connection (refused|reset)|too many connections|lock wait timeout|syntax error|violates (check|unique|foreign key) constraint)\\b', color: 'red', tier: 'signal', family: 'word-error' },
      // Redis 错误回复
      { keyword: '\\((error)\\)|\\b(WRONGTYPE|NOSCRIPT|NOAUTH|NOPERM|EXECABORT|CROSSSLOT|MOVED|CLUSTERDOWN|MASTERDOWN|READONLY|MISCONF|BUSYGROUP|OOM command not allowed)\\b', color: 'red', tier: 'signal', family: 'word-error' },
      // Redis 类型标记
      { keyword: '\\((integer|double|boolean|nil|empty array|empty list|empty set)\\)', color: sigM, tier: 'structure', family: 'redis-type' },
      // 状态行
      { keyword: '\\b(Query OK|Empty set|rows? affected|rows? matched|rows? returned|in set|PONG|QUEUED)\\b|\\(\\d+ rows?\\)', color: 'green', tier: 'signal', family: 'word-ok' },
      // 耗时（mysql / psql 结尾的 (0.01 sec)）
      { keyword: '\\(\\d+(?:\\.\\d+)? ?(?:sec|ms|min)\\)', color: '#2DD4BF', tier: 'structure', family: 'duration' },
      // 警告与性能提示
      { keyword: '\\b(WARNING|NOTICE|DEPRECATED|slow query|Using filesort|Using temporary|full table scan|seq scan|connection is read-only)\\b', color: 'yellow', tier: 'signal', family: 'word-warn' },
      // UUID
      { keyword: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', color: sigM, tier: 'structure', family: 'uuid' }
    ]
  }
]

// family → 归属组。批次 A 按文档顺序取首次声明者（此时 word-error / word-ok /
// word-warn / duration / host-port 仍被多组重复声明，见 keyword-family.spec.js 的
// 棘轮基线）；批次 B/C 去重完成后，本表即"一族一归属"的权威声明，
// 任何规则的组名与 FAMILY_HOME[family] 不一致都应被测试拦下。
export const FAMILY_HOME = (() => {
  const home = {}
  for (const p of keywordPresets) {
    for (const k of p.keywords) {
      if (!home[k.family]) {
        home[k.family] = p.name
      }
    }
  }
  return home
})()

// Append a preset's rules to existing keywords, skipping duplicates and the
// empty placeholder row the settings form starts with. The preset's required
// universal groups are expanded too, so applying one business preset pulls in
// the shared structure/signal rules it depends on.
export function mergeKeywordPreset (existing = [], preset) {
  const kept = existing.filter(k => k && k.keyword)
  const seen = new Set(kept.map(k => k.keyword + '\u0000' + (k.color || 'red')))
  const expand = p => {
    const out = p.keywords
      .filter(k => !seen.has(k.keyword + '\u0000' + (k.color || 'red')))
      .map(k => ({ ...k }))
    for (const k of out) seen.add(k.keyword + '\u0000' + (k.color || 'red'))
    return out
  }
  let added = expand(preset)
  for (const reqName of preset.requires || []) {
    const req = keywordPresets.find(p => p.name === reqName)
    if (req) added = added.concat(expand(req))
  }
  return [...kept, ...added]
}
