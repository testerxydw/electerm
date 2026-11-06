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
 * 2. **规则不写颜色**（V3 批次 E·B-1 起）。颜色由 `FAMILY_COLOR[family]` 派生：
 *    家族 → 色组 → 颜色，一族一色、一色一语义由构造保证。以前"共享规则的配色在
 *    定义处钉死"是手写 color 时代的纪律，现在写死一个 color 反而意味着它和家族脱钩。
 *    老配置里存的手写色在读取时按家族重新派生（见 keyword-groups.js 的 ruleColorOf），
 *    所以色板变更不需要迁移脚本；用户自定义规则的自选色不受影响。
 * 3. **同色 + 同类才合并成一条备选式**（如 ts+tsBracket、ipv6+mac、absPath+srcFile、
 *    dur+durKey），且保持原有先后顺序；不同色绝不合并（那是预设要表达的区别）。
 * 4. **每条规则按「全部预设同时勾选」的最坏情况计成本**，但现在结构档（时间戳/
 *    数值/地址/路径）默认不进全选，密度由 §7 覆盖率闸治理。
 *
 * 五处「让位护栏」（ipv4 的 (?!:\d)、ts 的 (?!\.\d)、lvlError 的 DOES NOT(?:…)、
 * num 的 (?<!status[=:]\s{0,2})、Docker 镜像的 (?![\w.-])）是家族不唯一时代的产物：
 * 同一个形状在两个组各写一份，只能靠"谁让谁"凑出颜色。批次 A 把裁决统一成
 * 「最左起点 → rank 小者胜 → 同 rank 取更长 → 等长取原序」（见 common/keyword-scan.js
 * 的 arbitrateAt / selectByRank），批次 C 消灭重复形状后逐条删除：ipv4 / ts / num /
 * 镜像四处已删净，lvlError 那条退化成同族内部的可选后缀（`DOES NOT(?: (?:EXIST|MATCH))?`，
 * 竞争双方都在 word-error 里，不再是跨家族让位）。
 * 剩余的 `(?!)` / `(?<!)` 全部是各自家族内部的正形约束（CIDR 尾巴、JSON 键名、
 * 秒表读数、地址语境 lookbehind…），不是护栏。**不允许为了过测试把跨家族让位护栏加回来。**
 */

// ---- 共享片段（全仓只在此定义一次）----
// 批次 C（KU-3）：删掉 (?!:\d) 让位护栏。IPv4 只认地址本身，`10.1.2.3:443` 由
// ipv4（rank 10）吃下地址、游标前进到冒号后由 port（rank 40）吃下 `:443`，
// 两段相邻、各归各族 —— 同一个 IP 在任何上下文里都是同一个颜色。
// CIDR 前缀长度必须在同一段里吃完，否则 `10.1.2.3/24` 的 `24` 会漏给 number。
const ipv4 = '\\b(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}(/\\d{1,2})?\\b'
// 主机名（带点的域名形制）：registry.example.com 这类以前被 package-name 抢走
const hostName = '\\b[a-z][a-z0-9-]*(?:\\.[a-z0-9-]+)+\\b'
// 端口：地址/主机名之后的 `:NN`，含 `->NN/tcp` 映射尾巴。
// KU-3 要求这个形状只在"确实跟在某个可寻址实体之后"时成立：前面的 lookbehind 就是
// 那个实体（IPv4 / [IPv6] / 多段冒号地址 / 域名 / ≥2 字母的服务名）。没有它，
// `/app/src/main.c:88` 的 `:88` 会被当成端口 —— 源码行号已由 file-line 家族整段认领，
// 但扩展名不在 srcExt 里的文件（以及任何 file-line 漏掉的形状）都会漏出一个假端口。
// (?<!") 挡住 JSON 键形状（"id":1024 不是端口），(?!\.\d) 挡住 1:25.5 这类秒表读数。
const addrBefore = '(?:\\d{1,3}(?:\\.\\d{1,3}){3}|\\[[0-9a-f:.]+]|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){1,7}|[a-z][a-z0-9-]*(?:\\.[a-z0-9-]{2,})+|[a-z][a-z0-9-]+)'
const portRef = '(?<!")(?<=' + addrBefore + '):\\d{2,5}\\b(?!\\.\\d)(?:->\\d{1,5}/(?:tcp|udp))?'
const ipv6 = '(?<![\\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?::[0-9a-f]{1,4}){1,7}|::)(?![\\w:])'
const mac = '\\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b|\\b[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}\\b'
const srcExt = 'c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|go|rs|java|kt|kts|scala|ts|tsx|js|jsx|mjs|cjs|py|pyi|rb|php|cs|swift|zig|lua|pl|pm|ex|exs|erl|dart|sh|bash|zsh|ps1|sql|json|ya?ml|toml|ini|cfg|conf|properties|styl|css|scss|sass|less|html|vue|svelte|md|txt|log|csv|tsv'
const srcFile = '\\b[\\w./~-]+\\.(' + srcExt + ')\\b'
// 起点用 (?<![\w./-]) 而不是 \b：绝对路径的第一个字符是 `/`（非词字符），\b 在那里
// 不成立，于是 `/app/src/main.c:88:5` 只能被 path 吃掉前半截、把 `:88:5` 漏给端口。
// 第二支给无扩展名的构建文件（`Makefile:12`、`Dockerfile:8`）：它们进不了 srcExt，
// 但 `NAME:行号` 这个形状属于源码位置族 —— 端口族的主机 lookbehind 认得出
// `Makefile` 是个"词"，却分不出它是主机名还是文件名，所以只能由本族先把整段吃掉。
const buildFile = 'Makefile|Dockerfile|Gemfile|Rakefile|CMakeLists\\.txt|Justfile|Taskfile'
const srcLoc = '(?<![\\w./-])[\\w./~-]+\\.(' + srcExt + ')\\b(:\\d+){1,2}' +
  '|(?<![\\w./-])(?:' + buildFile + ')(:\\d+){1,2}\\b'

// 时间戳（ISO 8601 / BSD syslog / 时钟）+ 方括号里的时间戳（nginx/dmesg/测试框架）
// 批次 C：删掉时钟分支尾部的 (?!\.\d) 让位护栏 —— timestamp rank 40 已经压在
// number rank 60 之上，同起点不需要再靠长度让位。
const ts = '(?<![":])\\b(?:\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?(?:Z|[+-]\\d{2}:?\\d{2})?' +
  '|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?' +
  '|\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d{1,6})?)?)\\b(?![":])'
const tsBracket = '\\[\\d{2}/\\w{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4}\\]|\\[\\s*\\d+\\.\\d+\\]|\\[\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?\\]'
const tsAll = tsBracket + '|' + ts

// 时长与体积共用的单位表（长单位排在单字母之前）
const unitTime = 'ns|us|µs|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|[smh]'
// 体积与吞吐
// 裸单字母只留 [KGTPE]。规则以 gi 编译（见 keyword-compile.js），[KMGTPE] 会把
// `5m` 同时认成"5 兆字节"和"5 分钟"（v4 §2.4 的抢色源头），而 JS 没有 (?-i:…) ——
// node 24 直接报 Invalid group，所以大小写在正则里不可判。裁决改由**单位表本身**承担：
// `M` 只在写成 MB/MiB 或前面带小数（`1.5M`）时算体积，整数裸 `5m/3s/1h` 唯一属于 duration；
// `233G`（df -h）照旧是体积。
const unitSize = 'bytes?|[KMGTPE]i?B|[KGTPE]i?|(?<=\\.\\d)M(?:i(?:B)?)?'
// 单字母单位里只有裸 `m` 强制整数（`5m` = 5 分钟，`1.5M` = 1.5 兆字节）：其余形状
// 与体积不冲突，小数照收（`0.5s`、`2h`、`3d` 都是时长）。
const unitTimeLong = 'ns|us|µs|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|d(?:ays?)?|[sdh]'
const dur = '\\b\\d+(?:\\.\\d+)?\\s?(?:' + unitTimeLong + ')\\b|\\b\\d+\\s?m\\b'
// AGE 列的复合形制（12m30s、3d4h）：至少两个单位，单个单位的已被 dur 覆盖。
// 批次 C 从 Docker 组上收 —— 同一个时长信号在两个组各写一份就是 KU-2 违规。
const durAge = '\\b\\d+[dhms](?:\\d+[dhms])+\\b'
// mysql / psql 结尾的 (0.01 sec)：同上，从 Database 组上收
const durParen = '\\(\\d+(?:\\.\\d+)? ?(?:sec|ms|min|us|ns)\\)'
// 时长：key=value 形式（单位必须是真实单位词，不能写成「任意 1-6 个字母」）
const durKey = '\\b(?:request_time|upstream_response_time|request_time_ms|duration|latency|elapsed|took|wall ?time)(?:[=:]\\s*|\\s+)\\d+(?:\\.\\d+)?(?:\\s?(?:' + unitTime + ')\\b)?'
const durAll = dur + '|' + durAge + '|' + durParen + '|' + durKey

const size = '\\b\\d+(?:\\.\\d+)?\\s?(?:' + unitSize + ')(?:/s)?\\b'

// 百分比：从裸数字里独立成族（rank 40 压在 number rank 60 之上，`45%` 不再两色竞争）
const percent = '\\b\\d+(?:\\.\\d+)?%'

// PCI / 设备地址（内核组独有，见 §6.2；不进通用档）
const devAddr = '\\b(?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\\.\\d\\b|\\b[0-9a-f]{4}:[0-9a-f]{4}\\b'

// 日志级别与泛用报错词（红档一条打尽）
// 批次 B 之后，红黄绿三档是全仓唯一的词表：业务组只留领域独有词（整词探测见
// keyword-family.spec.js 的 KU-4 闸），跨组共用的状态词一律上收到这里。
// 上收进来的词按 v4 §6 的裁决：dead → 红（进程/Pod 已死），listening / pending /
// waiting / retry / restarting / restarted / degraded → 黄（等待与降级），
// running / active / started / created / established / mounted / link up → 绿（正在/已达）。
// segfault 不在红档：它本来就是 exception-class 那个「XxxFault」形状的一个实例，
// 两处各写一份就是「一个词两个归属」，由形状族认领（同为红档、同 rank，观感不变）。
// JSON 键名保护也一并上收（Networking 原来在自家词表外面包了一层 (?<![":])…(?![":])，
// 词表搬进通用档后这层保护必须跟着搬，否则勾上 Networking 就会把 "errors":0 的键名染红）。
// 只挡「词后紧跟引号再跟冒号」这个键形状：值侧的 "status":"failed" 照染、ERROR: 前缀照染。
const notJsonKey = '(?!"\\s*:)'
const lvlError = '\\b(?:EMERG(?:ENCY)?|ALERT|CRITICAL|CRIT|SEVERE|FATAL|PANIC(?:KED)?|DEAD|' +
  'ERRORS?|ERR|EXCEPTIONS?|CAUSED BY|' +
  'FAIL(?:ED|ING|URE|URES)?|DENIED|DENY|REFUSED|REJECT(?:ED|ING)?|TIMEOUT|TIMED OUT|UNREACHABLE|' +
  'CORRUPT(?:ED|ION)?|SEGMENTATION FAULT|CORE[- ]DUMP(?:ED|ING)?|DROPPED|' +
  'ABORT(?:ED|ING)?|CRASH(?:ED|ING|ES)?|EXPIRED|REVOKED|VULNERABILIT(?:Y|IES)|' +
  'BAD|INCORRECT|INVALID|UNSUPPORTED|WRONG|MISMATCH|MISCONFIGURED|MISSING|' +
  'UNEXPECTED|UNAVAILABLE|UNRESOLVED|' +
  'CANNOT|CAN NOT|COULD ?NOT|SHOULD ?NOT|WOULD ?NOT|WILL ?NOT|DOES NOT(?: (?:EXIST|MATCH))?|DID NOT|' +
  "CAN'T|COULDN'T|SHOULDN'T|WOULDN'T|WON'T|DIDN'T|DOESN'T|" +
  'NOT (?:FOUND|ALLOWED|PERMITTED|AVAILABLE|SUPPORTED|RESPONDING|AUTHENTICATED|' +
  'INITIALIZED|ESTABLISHED|REACHABLE|VALID)|' +
  'NO SUCH \\w+|NO (?:ROUTE|PERMISSIONS?|RESPONSE|SPACE|MATCHING|ACCESS|AUTHENTICATION)|' +
  'UNDEFINED (?:REFERENCE|SYMBOL)|PERMISSION DENIED|ACCESS DENIED|EACCES|ENOENT)\\b' + notJsonKey + '|(?:✗|✘|✖)'
const lvlWarn = '\\b(?:WARN(?:ING)?S?|DEPRECATED|DEPRECATION|OUTDATED|HINT|DISABLED|UNKNOWN|' +
  'INCOMPATIBLE|LEGACY|DISABL(?:E|ED|ING)|PENDING|WAITING|RETRY(?:ING)?|RESTARTING|RESTARTED|DEGRADED|LISTENING)\\b' + notJsonKey
const lvlInfo = '\\bINFO(?:RMATION|RMATIONAL)?\\b' + notJsonKey
const lvlDebug = '\\b(?:DEBUG|TRACE|VERBOSE)\\b' + notJsonKey

// 异常类名
const exc = '\\b(?:[\\w$]+\\.)*[A-Z][\\w$]*(?:Error|Exception|Throwable|Fault|Panic)\\b'

// NULL 与布尔
const nullBool = '(?<![\\w"])\\b(?:NULL|NIL|NONE|UNDEFINED|NaN|TRUE|FALSE)\\b'

// 「这就是一次成功」的词
const wordOk = '\\b(?:OK|ALL OK|YES|SUCCESS(?:FUL(?:LY)?)?|PASSED|PASSES|VALID|VALIDATED|' +
  'CORRECT(?:LY)?|SUPPORTED|KNOWN|VERIFIED|RESOLVED|ENABLED|AVAILABLE|REACHABLE|' +
  'COMPLETE(?:D)?|FINISHED|SUCCEEDED|WORKING|NORMAL|STABLE|CONNECTED|READY|' +
  'ACCEPT(?:ED)?|GRANTED|CLEAN|UP[ -]TO[ -]DATE|' +
  'RUNNING|ACTIVE|STARTED|CREATED|ESTABLISHED|MOUNTED|LINK UP)\\b' + notJsonKey

// 裸数字（边界比 WindTerm 严，挡住各类抢占）
// 批次 C：`%?` 分支移除 —— 百分比由独立的 percent 族认领（rank 40 < 60）；
// (?<!status[=:]\s{0,2}) 让位护栏删除 —— http-status.* rank 55 已经压在 number rank 60 之上。
const num = '(?<![\\w.~/-])(?<!\\d:)(?<!"\\s)\\d+(?:\\.\\d+)?' +
  '(?![\\w~/:-])(?!\\.\\d)(?!\\s*\\(\\d+[dhms])' +
  '(?!\\s?(?:' + unitSize + ')(?:/s)?\\b)(?!\\s?(?:' + unitTime + ')\\b)(?!%)'

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
  'conflict-marker': 0,
  'diff-header': 0,
  'diff-hunk': 0,
  'diff-index': 0,
  'redis-type': 0,
  // 10 · exact-addr — 精确地址：IP / IPv6+MAC / URL / UUID / 指纹 / PCI——长度确定、误染代价最高
  fingerprint: 10,
  ipv4: 10,
  'ipv6-mac': 10,
  'pci-address': 10,
  url: 10,
  uuid: 10,
  // 20 · path — 路径与位置：绝对路径、源文件、file:line、栈帧
  'file-line': 20,
  path: 20,
  'py-file-line': 20,
  'stack-frame': 20,
  // 30 · domain-id — 领域标识：接口名、unit、设备、资源引用、镜像、git ref、SQL 关键词…
  'ahead-behind': 30,
  'auth-daemon': 30,
  'branch-line': 30,
  'commit-sha': 30,
  'daemon-tag': 30,
  'device-name': 30,
  'field-name': 30,
  'git-ref': 30,
  'http-method': 30,
  'image-ref': 30,
  'interface-name': 30,
  'kernel-version': 30,
  'merge-line': 30,
  'nft-target': 30,
  pid: 30,
  'pod-name': 30,
  'quoted-ident': 30,
  'resource-ref': 30,
  'signal-name': 30,
  'sql-keyword': 30,
  'thread-name': 30,
  'tls-word': 30,
  'trace-id': 30,
  'unit-name': 30,
  'user-agent': 30,
  username: 30,
  // 40 · num-time — 时间与数值：时间戳、时长、体积、百分比、端口、hex、命令行选项
  'cli-flag': 40,
  duration: 40,
  'hex-literal': 40,
  port: 40,
  percent: 40,
  'port-map': 40,
  'port-word': 40,
  'restart-count': 40,
  size: 40,
  timestamp: 40,
  // 50 · signal-word — 状态词：报错/警告/成功/跳过/异常类名/NULL——任何领域都同色，靠 rank 不被结构档抢。
  // 批次 B 之后各领域剩下的独有状态词也是一族一 rank，同层裁决仍是「最左 → 同 rank 取更长」。
  'auth-msg.err': 50,
  'auth-msg.ok': 50,
  'auth-msg.warn': 50,
  'build-verb': 50,
  'build-result.ok': 50,
  'exception-class': 50,
  'git-cmd.err': 50,
  'git-cmd.ok': 50,
  'git-cmd.warn': 50,
  'k8s-workload.err': 50,
  'k8s-workload.ok': 50,
  'k8s-workload.warn': 50,
  'kernel-msg.err': 50,
  'kernel-msg.ok': 50,
  'kernel-msg.warn': 50,
  'net-counter.err': 50,
  'net-iface-state.warn': 50,
  'net-link-state.err': 50,
  'net-link-state.ok': 50,
  'null-bool': 50,
  'redis-error': 50,
  'sql-error': 50,
  'sql-status.ok': 50,
  'sql-warn': 50,
  'systemd-unit.err': 50,
  'systemd-unit.ok': 50,
  'systemd-unit.warn': 50,
  'traceback-head': 50,
  'word-debug': 50,
  'word-error': 50,
  'word-info': 50,
  'word-ok': 50,
  'word-skip': 50,
  'word-warn': 50,
  // 55 · signal-grade — 分级族：按级别分色的族（HTTP 状态码、syslog severity、nginx 方括号级别）
  'bracket-level.err': 55,
  'bracket-level.info': 55,
  'bracket-level.warn': 55,
  'http-status.1xx2xx': 55,
  'http-status.3xx': 55,
  'http-status.4xx': 55,
  'http-status.5xx': 55,
  'syslog-sev.err': 55,
  'syslog-sev.info': 55,
  'syslog-sev.warn': 55,
  // 57 · domain-name — 主机名（批次 C 新增层）：带点域名压在分级族之后、兜底形状之前。
  // registry.example.com 以前被 package-name（rank 60）当包名抢走，现在由 host 家族认领；
  // exception-class rank 50 仍在它前面，所以 `java.lang.NullPointerException`
  // 整串仍然是红色异常类，不会被切成「包名 + 类名」两段。
  host: 57,
  // 60 · loose — 宽口径兜底：裸数字、包名——只在没有更精确的族命中时染
  number: 60,
  'package-name': 60
}

/* ------------------------------------------------------------------ *
 * V3 KU-6 色板（批次 E · B-1「一色一语义」+ B-2「间距重排」）
 *
 * 色组（color group）= 一个颜色承载的语义大类。契约：
 *   1) 一个色组恰好一个颜色，一个颜色不得跨两个色组；
 *   2) 家族恰好属于一个色组（FAMILY_GROUP），一族一色由构造保证；
 *   3) signal 色组只用六个 ANSI 语义名（随主题映射，观感跨主题稳定）；
 *   4) structure 色组一律真彩色，且两两拉开到肉眼一眼可辨（见下面的闸）；
 *   5) structure 色组不得长得像 signal 的主题色（否则「一色一语义」在屏幕上失效）。
 *
 * 规则的 color 字段不再手写：由 FAMILY_COLOR[family] 派生。历史包袱是 46 个结构家族
 * 里 35 个挤在 blue / magenta / cyan 上，同一个 magenta 同时表示"空值"和"端口/镜像/
 * UUID"——这就是用户看到的"颜色乱"。批次 A 的棘轮基线 35 在 B-1 清零。
 *
 * B-2 治的是剩下的「组内撞色」。B-1 之后色板仍然有一片分辨不出来的淡蓝，而且有一个结构色
 * 和主题的信号色几乎重合：size ↔ path ΔE(1976)=6.2（ΔE(2000)=4.5）、time ↔ number=18.6，
 * mac(#FF7BAC) 离主题的 ANSI magenta(#FF75B5) 只有 7.4——空值是一个信号词的颜色。
 * 本批把 16 个结构真彩色整体重排（一条正则、一个 rank 都没动）：
 *
 *   闸（keyword-family.spec.js 机检）        实测最低值             撞车对（B-2 前）
 *   pair ΔE(1976) >= 16                     16.0                   size↔path（原 6.2）
 *   pair ΔE(2000)  >= 8                      8.5                   time↔path（原 4.5，同为 size↔path）
 *   结构色 ↔ 内置主题 signal 色 >= 11         11.6                  number↔blue（原 7.4，是 mac↔magenta）
 *
 * ΔE(2000) 一起作为闸，因为 ΔE(1976) 在蓝段虚高：同样"看得出不同"的距离，蓝段要报的
 * 数字比绿段大得多，只按 ΔE(1976) 定闸会逼着蓝段颜色无谓地跑远。
 *
 * 第三条闸的锚点只取两套内置主题的 **normal** 变体（不含 bright*）：signal 档经 colorToCode
 * 发出的是 SGR 31–37，永远不会发 bright（高亮也不加粗，boldAsBright 用不上）。
 * 已知越界、且故意不拦的一对：number(#6EBDFE) 与深色主题 brightBlue(#6FC1FF) ΔE(1976)=2.4——
 * 那是别的程序加粗输出的颜色，不属于关键字高亮的语义空间；要把它纳进来就得让 number 离开蓝相，
 * 而"数值是蓝的"正是这一族的语义身份。
 *
 * 求解口径：每个家族的色相最多漂 16°（色的语义身份 = 色相，体积不能变成黄色），
 * 明度锁在 70–87、彩度 26–67（深色底上仍是一批亮色字），目标是最小化位移。
 * 结果：全板总位移 ΔE(2000)=21.7（ΔE(1976)=39.7）、单色最大 4.5（mac 为了让开主题 magenta
 * 从 358° 走到 8°）、其余 15 个颜色平均只动 1.2 —— 肉眼几乎是一套原色板。
 * 全局 ΔE(1976) ≥ 18 在这个口径下做不到——不计位移多轮重启的上限实测 17.5：16 个色要同时保持色相身份，
 * 淡蓝簇（time/size/number/path）挤在 229°–263° 上，第四对只能到 16.0。要过 18 只有三条路：并组
 * （体积并入数值，15 色）、放弃色相身份、或放宽到中色带（明度彩度不再整齐）。三者的代价都比
 * 16→17.5 的差距更伤语义，所以本批把闸钉在实测值。复核方法见 v4 文档 §5.5。
 * ------------------------------------------------------------------ */
export const COLOR_GROUPS = {
  // signal · ANSI 语义名
  error: { color: 'red', label: '错误 / 失败 / 冲突' },
  warning: { color: 'yellow', label: '警告 / 跳过 / 4xx' },
  success: { color: 'green', label: '成功 / 运行中 / 2xx' },
  info: { color: 'cyan', label: '信息 / 提示 / 3xx' },
  debug: { color: 'blue', label: '调试' },
  nullish: { color: 'magenta', label: '空值 / 布尔 / 杂项' },
  // structure · 真彩色
  time: { color: '#3ED1FF', label: '时间戳' },
  duration: { color: '#00D5C2', label: '时长' },
  size: { color: '#ABD3FF', label: '体积' },
  number: { color: '#6EBDFE', label: '数值 / 百分比 / 类型标注' },
  hexnum: { color: '#D3A9FF', label: '十六进制' },
  flag: { color: '#E6B33F', label: '命令行选项' },
  ip: { color: '#FD9CCA', label: 'IPv4 / 设备地址' },
  mac: { color: '#FF7D9C', label: 'IPv6 / MAC' },
  url: { color: '#F98F6E', label: 'URL' },
  port: { color: '#9CECB9', label: '端口 / 映射 / 重启计数' },
  ident: { color: '#A1C37C', label: '领域标识符（接口 / unit / 进程 / SQL…）' },
  artifact: { color: '#E0AD71', label: '制品与可复制引用（镜像 / git / UUID / trace）' },
  diffmark: { color: '#BFE35D', label: 'diff 边界记号' },
  action: { color: '#27CD92', label: '构建动作 / 进度' },
  path: { color: '#99E5FE', label: '路径与源文件' },
  loc: { color: '#7EE685', label: '位置（file:line / 栈帧）' }
}

// 家族 → 色组。分级族（http-status.* / syslog-sev.* / bracket-level.*）按级别各归一组。
// 批次 B 之后的领域状态族（net-* / systemd-* / kernel-* / k8s-* / git-* / auth-* / sql-*）
// 和通用五档同色：色组管的是「这类语义长什么样」，族管的是「这个词归谁」。
export const FAMILY_GROUP = {
  'word-error': 'error',
  'exception-class': 'error',
  'traceback-head': 'error',
  'conflict-marker': 'error',
  'signal-name': 'error',
  'syslog-sev.err': 'error',
  'http-status.5xx': 'error',
  'bracket-level.err': 'error',
  'net-link-state.err': 'error',
  'net-counter.err': 'error',
  'systemd-unit.err': 'error',
  'kernel-msg.err': 'error',
  'k8s-workload.err': 'error',
  'git-cmd.err': 'error',
  'auth-msg.err': 'error',
  'sql-error': 'error',
  'redis-error': 'error',
  'word-warn': 'warning',
  'word-skip': 'warning',
  'syslog-sev.warn': 'warning',
  'http-status.4xx': 'warning',
  'bracket-level.warn': 'warning',
  'py-file-line': 'warning',
  'net-iface-state.warn': 'warning',
  'systemd-unit.warn': 'warning',
  'kernel-msg.warn': 'warning',
  'k8s-workload.warn': 'warning',
  'git-cmd.warn': 'warning',
  'auth-msg.warn': 'warning',
  'sql-warn': 'warning',
  'word-ok': 'success',
  'http-status.1xx2xx': 'success',
  'branch-line': 'success',
  'net-link-state.ok': 'success',
  'systemd-unit.ok': 'success',
  'kernel-msg.ok': 'success',
  'k8s-workload.ok': 'success',
  'build-result.ok': 'success',
  'git-cmd.ok': 'success',
  'auth-msg.ok': 'success',
  'sql-status.ok': 'success',
  'word-info': 'info',
  'syslog-sev.info': 'info',
  'http-status.3xx': 'info',
  'bracket-level.info': 'info',
  'merge-line': 'info',
  'ahead-behind': 'info',
  'word-debug': 'debug',
  'null-bool': 'nullish',
  'field-name': 'nullish',
  'nft-target': 'nullish',
  timestamp: 'time',
  duration: 'duration',
  size: 'size',
  number: 'number',
  percent: 'number',
  'redis-type': 'number',
  'hex-literal': 'hexnum',
  'cli-flag': 'flag',
  ipv4: 'ip',
  'pci-address': 'ip',
  host: 'ip',
  'ipv6-mac': 'mac',
  url: 'url',
  port: 'port',
  'port-map': 'port',
  'port-word': 'port',
  'restart-count': 'port',
  'interface-name': 'ident',
  'unit-name': 'ident',
  'daemon-tag': 'ident',
  'device-name': 'ident',
  pid: 'ident',
  'thread-name': 'ident',
  'auth-daemon': 'ident',
  username: 'ident',
  'kernel-version': 'ident',
  'tls-word': 'ident',
  'http-method': 'ident',
  'sql-keyword': 'ident',
  'quoted-ident': 'ident',
  'image-ref': 'artifact',
  'pod-name': 'artifact',
  'resource-ref': 'artifact',
  'git-ref': 'artifact',
  'commit-sha': 'artifact',
  uuid: 'artifact',
  fingerprint: 'artifact',
  'trace-id': 'artifact',
  'user-agent': 'artifact',
  'package-name': 'artifact',
  'diff-header': 'diffmark',
  'diff-hunk': 'diffmark',
  'diff-index': 'diffmark',
  'build-verb': 'action',
  path: 'path',
  'file-line': 'loc',
  'stack-frame': 'loc'
}

// 家族 → 颜色（唯一的颜色来源；预设规则的 color 字段全部由它派生）
export const FAMILY_COLOR = Object.keys(FAMILY_GROUP).reduce((acc, f) => {
  acc[f] = COLOR_GROUPS[FAMILY_GROUP[f]].color
  return acc
}, {})

// rank 层级表（供设置面板与测试展示"这个信号属于哪一层"）
export const FAMILY_LAYERS = { marker: 0, 'exact-addr': 10, path: 20, 'domain-id': 30, 'num-time': 40, 'signal-word': 50, 'signal-grade': 55, 'domain-name': 57, loose: 60 }

const keywordPresetsRaw = [
  {
    name: '通用 · 级别与状态',
    tier: 'signal',
    description: '任何日志都会出现的结构类以外的语义信号：报错/失败词、告警、信息、调试、成功、异常类名、NULL/布尔。勾选业务组会自动连带点亮。',
    keywords: [
      { keyword: lvlError, tier: 'signal', family: 'word-error' },
      { keyword: lvlWarn, tier: 'signal', family: 'word-warn' },
      { keyword: lvlInfo, tier: 'signal', family: 'word-info' },
      { keyword: lvlDebug, tier: 'signal', family: 'word-debug' },
      { keyword: wordOk, tier: 'signal', family: 'word-ok' },
      { keyword: exc, tier: 'signal', family: 'exception-class' },
      { keyword: nullBool, tier: 'signal', family: 'null-bool' }
    ]
  },
  {
    name: '通用 · 时间与数值',
    tier: 'structure',
    description: '全仓最吵的结构档：时间戳、时长、体积、裸数字、十六进制、命令行选项。默认不进「全部应用」，按行覆盖率闸之后才出现。',
    keywords: [
      { keyword: tsAll, tier: 'structure', family: 'timestamp' },
      { keyword: durAll, tier: 'structure', family: 'duration' },
      { keyword: size, tier: 'structure', family: 'size' },
      { keyword: percent, tier: 'structure', family: 'percent' },
      { keyword: num, tier: 'structure', family: 'number' },
      { keyword: hex, tier: 'structure', family: 'hex-literal' },
      { keyword: optFlag, tier: 'structure', family: 'cli-flag' }
    ]
  },
  {
    name: '通用 · 地址与路径',
    tier: 'structure',
    description: '全仓最吵的结构档：IP、IPv6/MAC、绝对路径/源文件名、文件:行、URL。默认不进「全部应用」。',
    keywords: [
      { keyword: ipv4, tier: 'structure', family: 'ipv4' },
      { keyword: addr6, tier: 'structure', family: 'ipv6-mac' },
      { keyword: hostName, tier: 'structure', family: 'host' },
      { keyword: portRef, tier: 'structure', family: 'port' },
      { keyword: pathAll, tier: 'structure', family: 'path' },
      { keyword: srcLoc, tier: 'structure', family: 'file-line' },
      { keyword: url, tier: 'structure', family: 'url' }
    ]
  },

  // ---- 业务组：只留领域独有规则，靠 requires 连带通用档 ----
  {
    name: 'Networking',
    requires: ['通用 · 级别与状态', '通用 · 地址与路径'],
    description: 'Switch and router CLI output (Cisco, Juniper, Arista, HPE Aruba and Comware, Huawei, Ubiquiti EdgeOS, MikroTik, Hirschmann, Moxa and similar): link state, errors, syslog severity, IPs, MACs, interfaces',
    keywords: [
      // syslog severity: %FACILITY-<severity>-MNEMONIC
      { keyword: '%[A-Z0-9_]+-[0-3]-[A-Z0-9_]+', tier: 'signal', family: 'syslog-sev.err' },
      { keyword: '%[A-Z0-9_]+-4-[A-Z0-9_]+', tier: 'signal', family: 'syslog-sev.warn' },
      { keyword: '%[A-Z0-9_]+-[5-7]-[A-Z0-9_]+', tier: 'signal', family: 'syslog-sev.info' },
      // 链路形制词：只有交换机/控制器 CLI 会这么写（err-disabled / notconnect / A/D）
      { keyword: '\\b(administratively down|err-?disabled|notconnect|not connected|link down|down|adm)\\b|\\b[Au]/D\\b', tier: 'signal', family: 'net-link-state.err' },
      // 接口计数器报错（带 JSON 边界排除，键名不染）；泛用报错词已上收通用红档
      { keyword: '(?<![":])\\b(incomplete|crc|runts|giants|collisions?|input errors|output errors|discard(s|ed)?|drops?|blocking|blk|bkn|broken|alarm)\\b(?![":])', tier: 'signal', family: 'net-counter.err' },
      // 链路在用：up / A-D / forwarding 这类形制（connected/established/active 已上收通用绿档）
      { keyword: '(?<![":])\\b(up|permit(ted)?|forwarding|fwd|full|online|root)\\b(?![":])(?!\\s+\\d+\\s+(?:second|minute|hour|day|week|month|year)s?)|\\bu/u\\b', tier: 'signal', family: 'net-link-state.ok' },
      { keyword: '(?<![":])\\b(half|learning|lrn|lis|standby|shutdown|desg|altn|alternate|backup)\\b(?![":])', tier: 'signal', family: 'net-iface-state.warn' },
      // 接口名（多厂商，同蓝）
      { keyword: '\\b(GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|XGigabitEthernet|FastEthernet|Ethernet|Eth-Trunk|Port-channel|Bridge-Aggregation|Route-Aggregation|Management|Loopback|Tunnel|MEth|Vlanif|Vlan|BAGG|sfp-sfpplus|sfp|ether|switch|bridge|bond|wlan|pppoe|Trk|ae|br|XGE|FGE|GE|Gi|Te|Twe|Fo|Hu|Fa|Eth|Et|Ma|Po|Lo|Tu|Vl|\\d{2,3}GE)\\s?\\d+(/\\d+){0,3}(\\.\\d+)?\\b|\\b(ge|xe|et|fe|mge|lt|gr)-\\d+/\\d+/\\d+(\\.\\d+)?\\b|\\birb(\\.\\d+)?\\b|\\b(em|fxp|me)\\d+\\b|\\b(cpu|vlan|lag|ch)\\s?/?\\d+(/\\d+)?\\b|(?<![\\w./])\\d/\\d{1,2}(/\\d{1,2})?\\b', tier: 'structure', family: 'interface-name' }
    ]
  },
  {
    name: 'Syslog & systemd',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'journalctl, /var/log/syslog and messages, systemd unit output: severity, unit lifecycle states, unit names, timestamps, PIDs',
    keywords: [
      // unit lifecycle：dead/started/active/running/listening/mounted/pending/waiting/
      // retrying/degraded 已上收通用档，这里只留 systemd 独有的状态词
      { keyword: '\\b(inactive|killed|masked)\\b', tier: 'signal', family: 'systemd-unit.err' },
      { keyword: '\\b(starting|reached)\\b', tier: 'signal', family: 'systemd-unit.ok' },
      { keyword: '\\b(stopping|stopped|reloading|reload(ed)?|deactivating|activating|scheduled|restart)\\b', tier: 'signal', family: 'systemd-unit.warn' },
      // unit names
      { keyword: '\\b[a-z0-9][a-z0-9@._-]*\\.(service|socket|target|timer|mount|automount|device|path|slice|scope|swap)\\b', tier: 'structure', family: 'unit-name' },
      { keyword: '\\b(pid|PID)[= ]\\d+\\b', tier: 'structure', family: 'pid' },
      { keyword: '\\b(sshd|sudo|systemd|crond?|dbus-daemon|NetworkManager|polkitd|rsyslogd|logind|kernel)\\[[0-9]+\\]', tier: 'structure', family: 'daemon-tag' }
    ]
  },
  {
    name: 'Linux kernel & dmesg',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值'],
    description: 'dmesg, the kernel ring buffer and boot messages: OOM killer, segfaults, hardware and I/O errors, device, link and driver events',
    keywords: [
      // 内核事件短语（segfault 已归通用红档，retry/degraded/mounted/started 等状态词归通用档）
      { keyword: '\\b(kernel panic|general protection fault|unable to handle (kernel )?paging request|out of memory|oom[- ]kill(er)?|killed process|call trace|hardware error|machine check|medium error|unrecoverable (read|error)|i/o error|buffer i/o error|ext4-fs error|xfs .*corruption|reset .* failed|device not ready|link is not ready|firmware (bug|error)|stack corruption|bad rip value|blocked for more than)\\b', tier: 'signal', family: 'kernel-msg.err' },
      { keyword: '\\b(falling back|deferred|link is down|disconnected|removed|suspended|unstable|overcurrent|throttl(ed|ing)|thermal|under-voltage|over-voltage)\\b', tier: 'signal', family: 'kernel-msg.warn' },
      { keyword: '\\b(link is up|link becomes ready|registered|initialized|attached|detected|inserted|now attached|power on|resumed)\\b', tier: 'signal', family: 'kernel-msg.ok' },
      // device names
      { keyword: '\\b(ata\\d+(\\.\\d+)?|sd[a-z]\\d*|nvme\\d+n\\d+(p\\d+)?|mmcblk\\d+(p\\d+)?|dm-\\d+|md\\d+|eth\\d+|wlan\\d+|enp\\d+s\\d+|eno\\d+|wlp\\d+s\\d+|usb \\d+-\\d+(\\.\\d+)?|tty(S|USB|ACM)\\d+|br-\\d+|veth[0-9a-f]+)\\b', tier: 'structure', family: 'device-name' },
      // devAddr 归内核组独有（PCI 地址 / WWN）
      { keyword: devAddr, tier: 'structure', family: 'pci-address' },
      { keyword: '\\bLinux version \\S+\\b', tier: 'structure', family: 'kernel-version' }
    ]
  },
  {
    name: 'HTTP & web logs',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'nginx and Apache access and error logs, and most web framework request logs: methods, status codes by class, latency, upstream hosts, user agents, paths',
    keywords: [
      // 状态码按类分色（裸三位数字不误染）
      { keyword: '(?:(?<="\\s)|\\bstatus[=:]\\s*)5\\d{2}\\b', tier: 'signal', family: 'http-status.5xx' },
      { keyword: '(?:(?<="\\s)|\\bstatus[=:]\\s*)4\\d{2}\\b', tier: 'signal', family: 'http-status.4xx' },
      { keyword: '(?<="\\s)3\\d{2}\\b', tier: 'signal', family: 'http-status.3xx' },
      { keyword: '(?<="\\s)[12]\\d{2}\\b', tier: 'signal', family: 'http-status.1xx2xx' },
      // 请求行 + 协议版本（host:port 与裸 URL 交给通用档）
      { keyword: '\\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\\s+\\S+\\s+HTTP/|\\bHTTP/\\d(?:\\.\\d)?', tier: 'structure', family: 'http-method' },
      { keyword: '\\bupstream\\b', tier: 'signal', family: 'field-name' },
      // host:port 复合形状已在批次 C 拆掉：地址段归 ipv4/host、`:NN` 归 port，都在通用档
      { keyword: '\\b(Mozilla/5\\.0|curl/\\S+|Wget/\\S+|Googlebot(?:/\\S+)?|bingbot(?:/\\S+)?|python-requests/\\S+|Go-http-client/\\S+|okhttp/\\S+|PostmanRuntime/\\S+|Apache-HttpClient/\\S+|axios/\\S+|node-fetch/\\S+|Electron/\\S+)\\b', tier: 'structure', family: 'user-agent' },
      // error-log 的级别（[module:level]）
      { keyword: '\\[[\\w.:-]*(?:EMERG|ALERT|CRIT(?:ICAL)?|ERROR|ERR)\\]', tier: 'signal', family: 'bracket-level.err' },
      { keyword: '\\[[\\w.:-]*(?:WARN(?:ING)?|NOTICE)\\]', tier: 'signal', family: 'bracket-level.warn' },
      { keyword: '\\[[\\w.:-]*(?:INFO|DEBUG)\\]', tier: 'signal', family: 'bracket-level.info' }
    ]
  },
  {
    name: 'Application log levels',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'Generic application logs (log4j/slf4j, Python logging, Go slog, Rust tracing, Node winston/pino): levels, timestamps, thread and logger names, exception types, tracing ids',
    keywords: [
      // tracing / correlation ids, in "k=v" and in JSON "k": "v" form
      { keyword: '\\b(trace_?id|span_?id|request_?id|correlation_?id|session_?id|user_?id)["\']?\\s*[=:]\\s*["\']?[\\w.:-]+', tier: 'structure', family: 'trace-id' },
      // logger / package names: com.example.Foo, my.pkg.module
      { keyword: '\\b([A-Za-z_][A-Za-z0-9_]*\\.){2,}[A-Za-z_][A-Za-z0-9_]*\\b', tier: 'structure', family: 'package-name' },
      // thread names: [main], [worker-3], [pool-2-thread-1]
      { keyword: '\\[(main|worker[- ]?\\d+|pool-\\d+-thread-\\d+|Thread-\\d+|goroutine \\d+|[A-Za-z0-9_-]{1,20}-\\d+)\\]', tier: 'structure', family: 'thread-name' }
    ]
  },
  {
    name: 'Exceptions & Stack Traces',
    requires: ['通用 · 级别与状态'],
    description: 'Java/Python/Go crash signatures: exception classes, Caused by chains, at frames, Traceback blocks, native signal aborts and panic lines',
    keywords: [
      { keyword: '\\bat [\\w$.]+\\([^)]*\\)', tier: 'structure', family: 'stack-frame' },
      // Python 栈头整句（含括号）
      { keyword: 'Traceback \\(most recent call last\\)|\\bstack ?trace\\b', tier: 'signal', family: 'traceback-head' },
      { keyword: 'File "[^"]+", line \\d+', tier: 'signal', family: 'py-file-line' },
      { keyword: '\\b(SIGSEGV|SIGABRT|SIGKILL)\\b', tier: 'signal', family: 'signal-name' }
    ]
  },
  {
    name: 'Docker & Kubernetes',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'docker ps/images/compose and kubectl get/describe/logs output: container states, pod phases and events, resource references, image tags and digests, ports, ages, restart counts',
    keywords: [
      // pod/container 相位与状态（Failed|Error|Dead|Pending|Waiting|Restarting|Running|
      // Active|Started|Created|Ready|Available|Completed|Succeeded 等泛用词已归通用档）
      { keyword: '\\b(CrashLoopBackOff|ErrImagePull|ImagePullBackOff|InvalidImageName|OOMKilled|Evicted|FailedScheduling|BackOff|Unhealthy|Removing|NotReady|Terminating|NoSchedule)\\b|\\bExited \\([1-9]\\d*\\)', tier: 'signal', family: 'k8s-workload.err' },
      { keyword: '\\b(ContainerCreating|Init:\\d+/\\d+|PodInitializing|SchedulingDisabled|Paused|Preempting)\\b', tier: 'signal', family: 'k8s-workload.warn' },
      { keyword: '\\b(Healthy|Bound|Pulled|Deployed)\\b|\\bUp \\d+ (second|minute|hour|day|week|month|year)s?|\\bExited \\(0\\)', tier: 'signal', family: 'k8s-workload.ok' },
      // resource references: deployment/nginx, pods/nginx-1, svc/api
      { keyword: '\\b(pods?|deploy(ment)?s?|svc|services?|ingress(es)?|configmaps?|secrets?|statefulsets?|daemonsets?|replicasets?|jobs?|cronjobs?|namespaces?|nodes?|pv|pvc|endpoints?|hpa|events?)/[a-z0-9][a-z0-9.-]*\\b', tier: 'structure', family: 'resource-ref' },
      // generated pod / container names: nginx-7d9f8c6b5-x2k4p
      { keyword: '\\b[a-z0-9][a-z0-9-]*-[0-9a-f]{5,10}-[a-z0-9]{4,6}\\b', tier: 'structure', family: 'pod-name' },
      // AGE column（12m, 45s, 3d4h）已在批次 C 上收进通用 duration 族（durAge），此处不再重述
      // restart counts: "3 (4m ago)"
      { keyword: '\\b\\d+ \\(\\d+[dhms]+ ago\\)', tier: 'structure', family: 'restart-count' },
      // 镜像：常用镜像名（带 tag）、registry 引用、sha256 摘要
      // 批次 C：registry 主机段首字符限定为字母，纯数字段不再被认成镜像引用
      // （`10.1.2.3/24` 归 ipv4），同时删掉 (?![\w.-]) 让位护栏 ——
      // `nginx.conf` 由 path rank 20 在同一个起点上赢，不需要护栏让位。
      // 结尾的 (?![\w.]) 不是护栏而是**词尾锚**（KU-3：一条规则必须吃掉整个 token）：
      // 没有它，`python3 setup.py` 只染前六个字母、把 `3` 裸着留下，半个词一种色比不染更糟。
      { keyword: '\\b(nginx|redis|postgres|mysql|mariadb|mongo|alpine|ubuntu|debian|busybox|python|golang|openjdk|eclipse-temurin|rabbitmq|kafka|elasticsearch|traefik|haproxy|caddy|vault|consul|etcd|prometheus|grafana|jenkins|gitlab-runner|fluentd|fluent-bit|metrics-server|kube-[a-z-]+)(:[a-zA-Z0-9._-]+)?(?![\\w.])|\\b[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+(:\\d+)?/[a-z0-9._/-]+(:[a-zA-Z0-9._-]+)?\\b|\\bsha256:[0-9a-f]{12,64}\\b', tier: 'structure', family: 'image-ref' },
      // ports and port mappings
      { keyword: '\\b\\d{1,5}->\\d{1,5}/(tcp|udp)\\b', tier: 'structure', family: 'port-map' },
    ]
  },
  {
    name: 'Build & test output',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值', '通用 · 地址与路径'],
    description: 'gcc/clang, tsc, eslint, make, maven/gradle, go build and pytest/jest/go test/cargo test: diagnostics, file:line:col locations, pass/fail/skip results, timings',
    keywords: [
      { keyword: '\\b(skip|skipped|todo|xfail|xpass|ignored)\\b', tier: 'signal', family: 'word-skip' },
      // 通过/成功（通用 wordOk 已覆盖 ok/success/passed/finished 等；这里只留构建域独有的说法）
      { keyword: '\\b(PASS|build succeeded|build success(ful)?|compilation complete|compiled successfully|all tests passed)\\b|✔|✓|√', tier: 'signal', family: 'build-result.ok' },
      { keyword: '\\b(building|compiling|linking|bundling|transpiling|minifying|installing|resolving|downloading|fetching|running|executing|starting|cleaning|caching|packaging|publishing)\\b', tier: 'structure', family: 'build-verb' }
    ]
  },
  {
    name: 'Git',
    requires: ['通用 · 级别与状态', '通用 · 地址与路径'],
    description: 'git status/log/diff/fetch/push/pull/merge output: branch and tracking state, changed and untracked files, conflicts, commit ids, diff hunks',
    keywords: [
      // 冲突标记优先于普通 conflict 单词
      { keyword: '<{7}|={7}|>{7}', tier: 'signal', family: 'conflict-marker' },
      // 冲突说法（rejected/fatal/error/aborting 已归通用红档）
      { keyword: '\\b(conflict|conflicts|both modified|both added|both deleted|deleted by (us|them)|added by (us|them)|unmerged|non-fast-forward|failed to push|detached HEAD|refusing to|would be overwritten|not possible to fast-forward)\\b', tier: 'signal', family: 'git-cmd.err' },
      // 成功说法（up to date / created / successfully 已归通用绿档，通用档的 UP[ -]TO[ -]DATE 连字符版一并覆盖）
      { keyword: '\\b(already up to date|everything up-to-date|fast-forward|nothing to commit|working tree clean|deleted branch|merged|rebase(d)? successfully)\\b', tier: 'signal', family: 'git-cmd.ok' },
      // status 列的词——它们不是"警告"，是"这次改动是什么"，git 独有的说法
      { keyword: '\\b(modified|deleted|renamed|copied|untracked|staged|unstaged|diverged|no changes added to commit|changes not staged|changes to be committed)\\b', tier: 'signal', family: 'git-cmd.warn' },
      { keyword: '\\b(ahead of|behind) \\S+ by \\d+ commits?\\b', tier: 'signal', family: 'ahead-behind' },
      { keyword: '\\bon branch \\S+', tier: 'signal', family: 'branch-line' },
      { keyword: '\\b(Merge branch|Merge pull request|Merge remote-tracking branch|Merge tag)\\b', tier: 'signal', family: 'merge-line' },
      // 分支/远端引用
      { keyword: '\\b(HEAD|FETCH_HEAD|ORIG_HEAD|origin|upstream|main|master|develop|trunk|staging|production|release)/[\\w./-]+\\b', tier: 'structure', family: 'git-ref' },
      // commit id + index
      { keyword: '\\bcommit [0-9a-f]{7,40}\\b|\\b[0-9a-f]{40}\\b', tier: 'structure', family: 'commit-sha' },
      { keyword: '\\bindex [0-9a-f]{7,}\\.\\.[0-9a-f]{7,}( \\d+)?\\b', tier: 'structure', family: 'diff-index' },
      { keyword: '@@ -\\d+(,\\d+)? \\+\\d+(,\\d+)? @@', tier: 'structure', family: 'diff-hunk' },
      // diff 头与 +++/--- 文件头
      { keyword: '\\bdiff --(git|stat)\\b|(?<!\\S)(\\+\\+\\+|---) [ab]/\\S+', tier: 'structure', family: 'diff-header' }
    ]
  },
  {
    name: 'Auth & security',
    requires: ['通用 · 级别与状态', '通用 · 地址与路径'],
    description: 'sshd, sudo, PAM, fail2ban, nftables/iptables and TLS handshake output: logins, authentication failures, permission denials, blocked and allowed connections, key fingerprints',
    keywords: [
      // 认证失败说法（permission/access denied、not allowed、refused/denied/dropped、
      // revoked/expired、reject 已归通用红档）
      { keyword: '\\b(failed password|authentication failure|auth(entication)? fail(ed|ure)?|invalid user|unauthorized|forbidden|break-in|blocked|banned|certificate (has )?expired|self[- ]signed|unable to authenticate|too many authentication failures|connection closed by authenticating user|possible break-in attempt)\\b', tier: 'signal', family: 'auth-msg.err' },
      // 认证通过说法（established / granted / successful 已归通用绿档）
      { keyword: '\\b(Accepted (password|publickey|keyboard-interactive|none|gssapi[\\w-]*)|session opened|session closed|logged in|login successful|authenticated|new session|reverse mapping checking .* successful|COMMAND=)\\b', tier: 'signal', family: 'auth-msg.ok' },
      { keyword: '\\b(weak|insecure|attempt|partial|unknown key|reverse mapping|no matching host key)\\b', tier: 'signal', family: 'auth-msg.warn' },
      // 防火墙 verdict：只在括号或 policy/action/target 语境里染，否则裸 drop/accept/reject
      // 会和通用档的报错、成功词撞色（KU-4 同词异色）
      { keyword: '\\[(DROP|REJECT|ACCEPT|DNAT|SNAT|MASQUERADE)\\]|\\b(?:policy|action|target|verdict|flags)\\s*[=:]?\\s*(DROP|REJECT|ACCEPT|DNAT|SNAT|MASQUERADE)\\b', tier: 'signal', family: 'nft-target' },
      { keyword: '\\b(sshd|sudo|pam_[a-z]+|fail2ban|nft|iptables|firewalld|ufw|polkit|openssl|openssh|gssapi)\\b', tier: 'structure', family: 'auth-daemon' },
      // user names only where the surrounding words make it unambiguous
      { keyword: '(?<=\\buser )[a-z_][a-z0-9_-]*\\b|(?<=\\bfor )[a-z_][a-z0-9_-]*(?= from )', tier: 'structure', family: 'username' },
      { keyword: '\\bport \\d{1,5}\\b', tier: 'structure', family: 'port-word' },
      { keyword: '\\b(SHA256:[A-Za-z0-9+/]{43}=?|MD5:[0-9a-f]{2}(:[0-9a-f]{2}){15})', tier: 'structure', family: 'fingerprint' },
      { keyword: '\\b(TLSv1(\\.[0-3])?|SSLv3|TLS_AES_\\w+|ECDHE[\\w-]*|cipher|handshake|verify (returned|ok|error)|Cipher is)\\b', tier: 'structure', family: 'tls-word' }
    ]
  },
  {
    name: 'Database & SQL',
    requires: ['通用 · 级别与状态', '通用 · 时间与数值'],
    description: 'SQL statements and mysql, psql and redis-cli output, plus the values a result grid renders: statement keywords, NULL and booleans, quoted identifiers, error codes and SQLSTATE, status lines, timestamps, UUIDs, hex and bytea blobs',
    keywords: [
      // SQL 语句关键词合成一条规则
      { keyword: '\\b(GROUP BY|ORDER BY|PRIMARY KEY|FOREIGN KEY|IF NOT EXISTS|IF EXISTS|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMIT|ROLLBACK|SAVEPOINT|EXPLAIN|ANALYZE|VACUUM|MERGE|UPSERT|RETURNING|JOIN|UNION|INTERSECT|EXCEPT|DISTINCT|VALUES|WHERE|HAVING|LIMIT|OFFSET|REFERENCES|CONSTRAINT|CASCADE|RESTRICT|LIKE|ILIKE|BETWEEN|FROM|SET|INTO|TABLE|VIEW|INDEX|SEQUENCE|TRIGGER|PROCEDURE|FUNCTION|DATABASE|SCHEMA)\\b', tier: 'structure', family: 'sql-keyword' },
      // 引用标识符
      { keyword: '`[^`\\n]{1,64}`|"[A-Za-z_][\\w$]*"(?:\\."(?:[A-Za-z_][\\w$]*|\\*)")*', tier: 'structure', family: 'quoted-ident' },
      // 报错（ERROR/FATAL/PANIC/access denied/does not exist 已归通用红档）
      { keyword: '\\b(ER_[A-Z0-9_]+|SQLSTATE|DEADLOCK|DEADLOCK DETECTED|duplicate (key|entry|column)|already exists|unknown (column|table|database|relation)|connection (refused|reset)|too many connections|lock wait timeout|syntax error|violates (check|unique|foreign key) constraint)\\b', tier: 'signal', family: 'sql-error' },
      // Redis 错误回复
      { keyword: '\\((error)\\)|\\b(WRONGTYPE|NOSCRIPT|NOAUTH|NOPERM|EXECABORT|CROSSSLOT|MOVED|CLUSTERDOWN|MASTERDOWN|READONLY|MISCONF|BUSYGROUP|OOM command not allowed)\\b', tier: 'signal', family: 'redis-error' },
      // Redis 类型标记
      { keyword: '\\((integer|double|boolean|nil|empty array|empty list|empty set)\\)', tier: 'structure', family: 'redis-type' },
      // 状态行（Query OK 的 OK 归通用绿档）
      { keyword: '\\b(Empty set|Query OK|rows? affected|rows? matched|rows? returned|in set|PONG|QUEUED)\\b|\\(\\d+ rows?\\)', tier: 'signal', family: 'sql-status.ok' },
      // 耗时（mysql / psql 结尾的 (0.01 sec)）已在批次 C 上收进通用 duration 族（durParen）
      // 警告与性能提示（WARNING / DEPRECATED 已归通用黄档）
      { keyword: '\\b(NOTICE|slow query|Using filesort|Using temporary|full table scan|seq scan|connection is read-only)\\b', tier: 'signal', family: 'sql-warn' },
      // UUID
      { keyword: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', tier: 'structure', family: 'uuid' }
    ]
  }
]

// 颜色只有一个来源：family → 色组 → 颜色。规则里手写 color 的旧写法已废除——
// 手写值要么与派生值不一致（破坏 KU-1 一族一色），要么把结构家族拉回
// blue / magenta / cyan（破坏 KU-6 一色一语义）。
export const keywordPresets = keywordPresetsRaw.map(preset => ({
  ...preset,
  keywords: preset.keywords.map(rule => {
    const color = FAMILY_COLOR[rule.family]
    if (!color) {
      throw new Error(`[keyword-presets] family "${rule.family}" 未登记 FAMILY_GROUP，无法派生颜色`)
    }
    return { ...rule, color }
  })
}))

// family → 归属组。批次 A 按文档顺序取首次声明者（当时 word-error / word-ok /
// word-warn / duration / host-port 还被多组重复声明）；批次 B 收掉词表复制、
// 批次 C 收掉形状复制之后，跨组复用已经归零（keyword-family.spec.js 的 KU-2 硬断言），
// 本表即"一族一归属"的权威声明：任何规则的组名与 FAMILY_HOME[family] 不一致都应被测试拦下。
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
