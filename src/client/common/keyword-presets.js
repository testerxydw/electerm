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
 *     rather than copied: four word tiers (token.error/success/warn/info-token)
 *     map to lvlError/wordOk/lvlWarn/wordNote, markup.heading (date, IPv4/IPv6,
 *     MAC) to ts/ipv4/ipv6/mac, constant.numeric to num, variable.language to
 *     optFlag, entity.name.filename to absPath, and the ls-style permission
 *     string to permStr. Its PCRE-only syntax (possessive quantifiers, POSIX
 *     classes like [[:xdigit:]], recursive (?<n>…)\g<n>) has to be rewritten,
 *     and three of its rules cannot be expressed here at all — see the notes on
 *     the Shell & command output preset.
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
// 末尾的 (?!:\d) 是把「IP:端口」整段让给端口映射档（magenta）：那条与本条同起点但
// 更长，而终端的重叠裁决是「同起点取更短」、网格是「同起点取更长」，不加这道护栏，
// docker ps 的 0.0.0.0:8080 在终端只染前 7 个字符、在网格里染整段，两处结论不一样。
const ipv4 = '\\b(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}(/\\d{1,2})?\\b(?!:\\d)'
const ipv6 = '(?<![\\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?::[0-9a-f]{1,4}){1,7}|::)(?![\\w:])'
const mac = '\\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b|\\b[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}\\b'
const srcExt = 'c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|go|rs|java|kt|kts|scala|ts|tsx|js|jsx|mjs|cjs|py|pyi|rb|php|cs|swift|zig|lua|pl|pm|ex|exs|erl|dart|sh|bash|zsh|ps1|sql|json|ya?ml|toml|ini|cfg|conf|properties|styl|css|scss|sass|less|html|vue|svelte|md|txt|log|csv|tsv'
// source file name, and file:line(:col) as printed by compilers and stack traces
const srcFile = '\\b[\\w./~-]+\\.(' + srcExt + ')\\b'
const srcLoc = '\\b[\\w./~-]+\\.(' + srcExt + ')\\b(:\\d+){1,2}'

// 时间戳：ISO 8601 / BSD syslog / 时钟（WindTerm 的 datetime 档认 1-2 位小时的
// hh:mm 与 hh:mm:ss，本条按它放宽，否则 ls -l 的「08:57」只有一半被染成数字色），
// 合成一条（原本三条各扫一遍整行，且各预设给它们配过 cyan / magenta / blue 三种色）。
// 小数秒只在有「秒」段时才吃：否则 PCI 地址 00:02.0 会被当成「00:02 加小数」的
// 时钟抢走（同起点两条等长时，先编译的那条赢，时钟排在设备地址前面）。
// 前后排除引号和冒号，这样 JSON 里的 "created_time":"2026-10-09 10:24:57" 不会被当成时间戳。
const ts = '(?<![":])\\b(?:\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?(?:Z|[+-]\\d{2}:?\\d{2})?' +
  '|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\\d{1,2} \\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?' +
  '|\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d{1,6})?)?(?!\\.\\d))\\b(?![":])'

// 方括号里的时间戳：nginx/Apache 的 [09/Oct/2026:08:57:36 +0800]、dmesg 的 [   12.345678]、
// 测试框架的 [00:12:34.567]
const tsBracket = '\\[\\d{2}/\\w{3}/\\d{4}:\\d{2}:\\d{2}:\\d{2} [+-]\\d{4}\\]|\\[\\s*\\d+\\.\\d+\\]|\\[\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?\\]'

// 时长与体积共用的单位表（原本 4 份单位列表各抄一遍，全是 cyan）。长单位排在
// 单字母之前，否则 "10 min" 会被 [smh] 抢走前半截。
const unitTime = 'ns|us|µs|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|[smh]'
const unitSize = 'bytes?|[KMGTPE]i?B|[KMGTPE]'

// 时长：数字 + 单位
const dur = '\\b\\d+(?:\\.\\d+)?\\s?(?:' + unitTime + ')\\b'

// 时长：key=value 形式（request_time=0.012 / took 12ms / elapsed: 3.2 s）。
// 单位必须是真实单位词，不能写成「任意 1-6 个字母」——那会让
// request_time=0.012 upstream_response_time=0.008 里的 "upstre" 被当成单位吃掉，
// 顺带毁掉后半截 key 的匹配。
const durKey = '\\b(?:request_time|upstream_response_time|request_time_ms|duration|latency|elapsed|took|wall ?time)(?:[=:]\\s*|\\s+)\\d+(?:\\.\\d+)?(?:\\s?(?:' + unitTime + ')\\b)?'

// 体积与吞吐：字节数、[KMGT]i?B、df -h / du -h / ls -lh 的裸单位（233G），
// 以及 dmesg 的 220 MB/s。裸单位只认大写 K/M/G/T/P/E，`40GE1/0/1` 这种
// 接口名因为单位后面还有单词字符（\b 不成立）不会被吃掉。
const size = '\\b\\d+(?:\\.\\d+)?\\s?(?:' + unitSize + ')(?:/s)?\\b'

// PCI / 设备地址：lspci 默认输出的 00:02.0、dmesg 与 lspci -D 的 0000:3b:00.0，
// 以及 WWN 式的 1234:5678。域名段可省，否则裸 `00:02.0` 的尾巴会被 num 捡走半截。
const devAddr = '\\b(?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\\.\\d\\b|\\b[0-9a-f]{4}:[0-9a-f]{4}\\b'

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
// commit）抢成红色。DOES NOT 后面带可选的 EXIST/MATCH：数据库预设把「does not
// exist」整句记红，与本条同起点却更长，同一起跑线上终端只染前两个词、网格染整句，
// 让本条自己吃下整句，两处才拿到同一个跨度。
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
// disabled/unknown 在 WindTerm 是红档，但「未开启 / 认不出来」在 syslog、构建、
// 内核日志里是提醒而不是失败，留在黄档；顺带把只有网络预设认得的 incompatible/
// legacy 提到共享黄档，让日志侧的「兼容性警告」也能染上色。
const lvlWarn = '\\b(?:WARN(?:ING)?S?|DEPRECATED|DEPRECATION|OUTDATED|HINT|DISABLED|UNKNOWN|INCOMPATIBLE|LEGACY)\\b'
// NOTICE 不再单独一条 cyan：它是 Database 组黄档 (WARNING|NOTICE|DEPRECATED|…)
// 的真子集（同起点同跨度，原本靠「等跨度取原序最先」才赢下 cyan），按「子集并入
// 包含者」删除，裸 NOTICE 改随包含者染黄。
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

// ---- 以下规则来自 WindTerm 默认 Linux 方案的结构档（见文件头说明）----
// wordOk / wordNote / num / optFlag / absPath / permStr 是本文件新增的六条；
// hex 与 Database 预设、devAddr 与内核预设原本各已有一份，这里收编成共享对象。

// 「这就是一次成功」的词，对齐 WindTerm 的 token.success-token 档。
// 不跟 WindTerm 的 true/false/none（那里是绿/红）：本文件把布尔值归 magenta
// （nullBool），改色会让数据库网格和终端两套裁决给出不同结论。
// 也不跟裸的 can / any / yes-is-prose 之类：「can」在英文里到处都是。
const wordOk = '\\b(?:OK|ALL OK|YES|SUCCESS(?:FUL(?:LY)?)?|PASSED|PASSES|VALID|VALIDATED|' +
  'CORRECT(?:LY)?|SUPPORTED|KNOWN|VERIFIED|RESOLVED|ENABLED|AVAILABLE|REACHABLE|' +
  'COMPLETE(?:D)?|FINISHED|SUCCEEDED|WORKING|NORMAL|STABLE|CONNECTED|READY|' +
  'ACCEPT(?:ED)?|GRANTED|CLEAN|UP TO DATE)\\b'

// 安全/会话类名词，对齐 WindTerm 的 token.info-token 档（access/authentication/
// connection/login/operation/password/permission）。WindTerm 那档还含 info 一词，
// 本文件的 info 已在 lvlInfo（cyan）里，同一条正则两种配色会被去重掉一种，故不重复。
// 后面的否定式 lookahead 是硬需求：Auth/Database 预设把「access denied」
// 「connection refused」整句记红，那条红档与本条同起点但更长，而终端的重叠裁决是
// 「同起点取更短」——不加这道护栏，红档整句会被截成蓝色的前半截。
const wordNote = '\\b(?:ACCESS|AUTH(?:ENTICATION|ORIZATION)|CONNECTION|DISCONNECTION|' +
  'LOGIN|LOGOUT|OPERATION|PASSWORD|PASSPHRASE|PERMISSION|CREDENTIALS?|USERNAME|' +
  'PRIVATE KEY|PUBLIC KEY|FINGERPRINT)' +
  '(?!\\s+(?:DENIED|REFUSED|REJECTED|FAIL(?:ED|URE|S)?|ERRORS?|INVALID|RESET|CLOSED|' +
  'BROKEN|LOST|TIME(?:OUT|ED)|EXPIRED|REVOKED|UNAUTHORIZED|SUCCESS(?:FUL)?|OPENED|GRANTED|ACCEPTED))\\b'

// 裸数字：WindTerm 的 constant.numeric 档。本文件的数字类规则（时间戳/时长/体积/
// 百分比/AGE/端口）一律 cyan，这里也取 cyan，避免同一行出现两种数字色。
// 边界比 WindTerm 严，每一条都在挡一个具体的抢占：
//   - 前后排除 单词字符 . / ~ -（后面还额外排除 :）→ IP 10.1.2.3、时钟 08:57:36、
//     ISO 日期 2026-11-03、端口映射 8080->80、MAC 00:11:22 都不会被拆成半截数字；
//   - 后面排除「. + 数字」→ 版本号 6.6.44 保持整段不动（WindTerm 会把它染色）；
//   - 前面排除「" + 空白」和「status[=:] + 空白」→ HTTP 预设按 2xx/3xx/4xx/5xx
//     分色的状态码与本条同起点同长度，终端取短、网格取长，两边结论会不一样，
//     所以直接把状态码的位置让出去，不靠规则的排列顺序；
//   - 前面排除「数字 + :」→ 时钟 08:57:36 的后半截不能当独立数字染色（ts 规则
//     已经把整段认成时间戳，同起点抢短的话会让「08」和「57」分两截）；
//   - 后面排除「空白 + (数字+单位」→ docker ps 的重启次数「12 (30s ago)」整句 magenta；
//   - 后面排除体积/时长单位 → df -h 的 233G、日志里的 220 MB/s、`0.01 sec`、
//     `1.5 s` 整段交给 size / dur 染色，不在这里只吃掉数字那一半（同为 cyan，
//     但单位尾巴该一起亮）。
// 负数（-5）不认：放行前导「-」会让 ISO 日期和 --flag 的尾巴漏进来。
const num = '(?<![\\w.~/-])(?<!\\d:)(?<!"\\s)(?<!status[=:]\\s{0,2})\\d+(?:\\.\\d+)?%?' +
  '(?![\\w~/:-])(?!\\.\\d)(?!\\s*\\(\\d+[dhms])' +
  '(?!\\s?(?:' + unitSize + ')(?:/s)?\\b)(?!\\s?(?:' + unitTime + ')\\b)'

// 十六进制字面量（WindTerm 的 0x… 与地址），与 Database 预设的 hex 档同色；
// 后者原本还多认 PostgreSQL bytea 的 \x… 转义，这里一并收下，两边共用同一条。
const hex = '\\b0x[0-9a-f]{2,}\\b|\\\\x[0-9a-f]{2,}'

// 命令行选项：WindTerm 的 variable.language 档（--?\w[-\w]*，可带 =值）。
// 中间的 (?:-[A-Za-z][\w]*)* 而不是 [\w-]*，是为了不吃掉 ls -l 的权限串——
// 「-rw-r--r--」若按 [\w-]* 贪婪匹配，整串会被当成一个选项名染黄。
const optFlag = '(?<![\\w/~-])-{1,2}[A-Za-z][\\w]*(?:-[A-Za-z][\\w]*)*(?:=[^\\s,;)]*)?(?![-\\w])'

// 绝对路径：WindTerm 的 entity.name.filename 档。那里按「/段/段」无限制匹配，
// 这里要求首段前有边界（(?<![\w/])），所以 "and/or"、"10/08/26"、"HTTP/1.1"
// 这些带斜杠的普通文本不会被认成路径；相对路径（src/x.js）交给 srcFile 规则。
// Auth & security 预设原来内联了一份「只认常见根目录」的写法，本条是它的超集，
// 两边共用同一个对象（同色 blue），不再各存一份正则文本。
// 尾段可选（单段也算，如 /favicon.ico、/api）：HTTP 预设原本自己内联了一条更宽
// 的单段路径档，与本条同起点、同色但更短，终端取短会把 /bin/bash 只染成 /bin，
// 网格取长又连冒号一起染——现在单段只由本条一处表达，两处裁决拿到同一个跨度。
const absPath = '(?<![\\w/])(?:/(?:etc|var|home|root|usr|opt|tmp|srv|run|proc|sys|dev|bin|sbin|lib|lib64|mnt|media|config)(?![\\w-])(?:/[\\w.@+~/-]*)?|/[\\w.@+~-]{2,}(?:/[\\w.@+~-]*)*/?)'

// ls -l / stat 的权限串：WindTerm 逐字符分色（文件类型/ r / w / sxst）。
// 本引擎只给整条匹配配一种颜色，所以整串取 blue（与路径、文件名同一类信号），
// 至少让「这一列是模式位」这件事看得出来，且不抢掉同行的数字与文件名。
const permStr = '(?<!\\S)[bcCdDlMnpPs?-](?:[rw-]{2}[xsStT-]){3}[.+]?(?=\\s|$)'

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
  num: { keyword: num, color: 'cyan' },
  hex: { keyword: hex, color: 'magenta' },
  devAddr: { keyword: devAddr, color: 'magenta' },
  srcFile: { keyword: srcFile, color: 'blue' },
  srcLoc: { keyword: srcLoc, color: 'magenta' },
  absPath: { keyword: absPath, color: 'blue' },
  optFlag: { keyword: optFlag, color: 'yellow' },
  permStr: { keyword: permStr, color: 'blue' },
  lvlError: { keyword: lvlError, color: 'red' },
  lvlWarn: { keyword: lvlWarn, color: 'yellow' },
  lvlInfo: { keyword: lvlInfo, color: 'cyan' },
  lvlDebug: { keyword: lvlDebug, color: 'blue' },
  wordOk: { keyword: wordOk, color: 'green' },
  wordNote: { keyword: wordNote, color: 'blue' },
  exc: { keyword: exc, color: 'red' },
  nullBool: { keyword: nullBool, color: 'magenta' }
}

export const keywordPresets = [
  {
    // WindTerm 默认连上 Linux 会话时就吃这一套（安装包内
    // terminal/schemes/linux/linux.lexer），所以把它放在分组列表最前面，
    // 作为「什么日志都不挑、只想让终端像 WindTerm」时的第一个勾选。
    // 三档 WindTerm 规则在本引擎里表达不出来，已刻意不搬：
    //   - prompt 行内的 command / option 分色：需要「这一行是 shell 提示符」的行级
    //     状态，终端插件按写入片段扫描，没有提示符上下文；
    //   - 引号字符串整体染色：本引擎给整条匹配配一种颜色，字符串规则会把引号里的
    //     时间戳、IP、数字全吞掉，JSON 单元格会整片变黄；
    //   - 权限串逐字符分色（类型/r/w/sxst 四色）与裸月份名、星期名：编译固定吃
    //     `gi`，月份名会连英文里的 may/sat/sun 一起染色，只有一种配色又比
    //     WindTerm 的按位分色更难看。
    // 词档直接复用共享的 lvlError/lvlWarn/lvlInfo/wordOk/wordNote，不另开「带 JSON
    // 键名护栏」的副本（那违反「一条正则只出现一次」，且与日志类预设口径不一致）：
    // 代价是只勾这一组时，`"errors":0`、`"ok":true` 这类键名也会染色——和勾了
    // 「Application log levels」的既有行为相同。数字/体积/时长/PCI/时间戳同样与
    // 内核、nginx、数据库各组共用同一个规则对象。
    name: 'Shell & command output',
    description: 'WindTerm-style highlighting for ordinary shell output (ls, ps, df, free, curl, systemctl, make and other CLI): failure/success/informational words, --options, absolute paths, ls-style permission strings, bare numbers, hex, timestamps, sizes, PCI addresses, IPv4/IPv6/MAC',
    keywords: [
      rule.lvlError,
      rule.lvlWarn,
      rule.lvlInfo,
      rule.wordOk,
      rule.wordNote,
      rule.optFlag,
      rule.absPath,
      rule.permStr,
      rule.num,
      rule.hex,
      rule.size,
      rule.dur,
      rule.ts,
      rule.tsBracket,
      rule.devAddr,
      rule.ipv4,
      rule.ipv6,
      rule.mac
    ]
  },
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
      { keyword: '(?<![":])\\b(up|connected|link up|permit(ted)?|forwarding|fwd|full|established|active|success(ful)?|enabled?|ok|online|reachable|root)\\b(?![":])(?!\\s+\\d+\\s+(?:second|minute|hour|day|week|month|year)s?)|\\bu/u\\b', color: 'green' },
      { keyword: '(?<![":])\\b(warning|warn|half|learning|lrn|listening|lis|standby|disabled?|shutdown|pending|unknown|desg|altn|alternate|backup)\\b(?![":])', color: 'yellow' },
      // 接口名：Cisco/Arista/Dell(Gi1/0/1, Et1, Po1, Vlan600)、Huawei(XGigabitEthernet0/0/1,
      // 40GE1/0/1, Eth-Trunk1, Vlanif10)、HP Comware(XGE1/0/1, BAGG1)、ProCurve(Trk1)、
      // MikroTik(ether1, sfp-sfpplus1)、EdgeOS(eth0, eth1.100, switch0, br0)、
      // Juniper(ge-0/0/0, irb.100, em0)、槽位口(1/1, cpu/1, lag/1)；cpuN 原本是
      // 内核组单列的 magenta 真子集，已并入这里的 (cpu|vlan|lag|ch) 分支。
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
      // 裸 NOTICE 不再单独一条：它是 Database 组黄档的子集，已并入（见文件头 lvlWarn 注）
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
      rule.devAddr,
      // cpuN 设备名不再单列 magenta：Networking 组接口名的 \b(cpu|vlan|lag|ch)…\b
      // 分支是它的包含者（且同起点跨度相等或更长），按「子集并入包含者」删除，
      // 整组启用时 cpuN 随接口名染蓝。
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
      // URL、请求行、协议版本：三条同色 blue，合成一条。
      // 独立的单段路径（/favicon.ico）不再由本条内联，改引用共享的 absPath：那条
      // 与本条同起点同色却更短，终端取短会把多段路径只染首段、网格取长又连冒号染
      // 进去，两处跨度对不上。
      { keyword: '\\bhttps?://[^\\s"\']+|\\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\\s+\\S+\\s+HTTP/|\\bHTTP/\\d(?:\\.\\d)?', color: 'blue' },
      rule.absPath,
      rule.dur,
      rule.durKey,
      { keyword: '\\bupstream\\b', color: 'magenta' },
      // host:port, but not the "08:57" inside a timestamp. 尾部的 ->端口/协议 与
      // 网络组的任意地址档保持一致：两条都在 0.0.0.0:8080 这个起点上命中，一端带
      // 尾巴一端不带，终端取短、网格取长，同一个端口映射在两个地方跨度就不一样
      { keyword: '\\b(?:[a-z][a-z0-9.-]*|\\d{1,3}(?:\\.\\d{1,3}){3}):\\d{2,5}(?:->\\d{1,5}/(?:tcp|udp))?\\b', color: 'magenta' },
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
      // 裸 NOTICE 已并入 Database 组黄档（子集规则，见 lvlWarn 注）
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
      { keyword: '\\b(Pending|ContainerCreating|Init:\\d+/\\d+|PodInitializing|Waiting|SchedulingDisabled|Unknown|Paused|Restarting|Preempting|Warning)\\b', color: 'yellow' },
      // Completed / Succeeded 是「正常跑完」，与共享的 wordOk 绿档同色：留在黄档
      // 会让同一个词在两个预设里拿到不同配色
      { keyword: '\\b(Running|Ready|Healthy|Active|Bound|Started|Pulled|Created|Available|Deployed|Completed|Succeeded|Up \\d+ (second|minute|hour|day|week|month|year)s?)\\b|\\bExited \\(0\\)', color: 'green' },
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
      // "nginx"（nginx-7d9f8c6b5-x2k4p）不被单独拆开染色。点位也一并排除：
      // systemd 预设的 nginx.service 与本条同起点、更长却不同色，终端取短会把这个
      // 单元名染成「紫 nginx + 蓝 .service」，网格取长则是整段蓝，两处不一样
      { keyword: '\\b(nginx|redis|postgres|mysql|mariadb|mongo|alpine|ubuntu|debian|busybox|python|golang|openjdk|eclipse-temurin|rabbitmq|kafka|elasticsearch|traefik|haproxy|caddy|vault|consul|etcd|prometheus|grafana|jenkins|gitlab-runner|fluentd|fluent-bit|metrics-server|kube-[a-z-]+)(:[a-zA-Z0-9._-]+)?(?![\\w.-])|\\b[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d+)?/[a-z0-9._/-]+(:[a-zA-Z0-9._-]+)?\\b|\\bsha256:[0-9a-f]{12,64}\\b', color: 'magenta' },
      // ports and port mappings. The any-address form swallows its own
      // "->80/tcp" tail: the IPv4 rule now yields "IP:port" to this rule, so a
      // mapping that stopped at the port would leave the tail uncolored.
      { keyword: '\\b\\d{1,5}->\\d{1,5}/(tcp|udp)\\b', color: 'magenta' },
      { keyword: '(?<![\\w])(?:0\\.0\\.0\\.0|\\*|::):\\d{1,5}(?:->\\d{1,5}/(?:tcp|udp))?\\b', color: 'magenta' },
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
      // 绝对路径与 Shell 输出预设共用同一条（同色 blue）
      rule.absPath,
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
      // 警告与执行计划里的性能提示；NOTICE 原本另有共享 cyan 单条（其真子集），
      // 已并入这里——裸 NOTICE 随本条染黄
      { keyword: '\\b(WARNING|NOTICE|DEPRECATED|slow query|Using filesort|Using temporary|full table scan|seq scan|connection is read-only)\\b', color: 'yellow' },
      // 时间戳复用共享写法（已带 JSON 边界排除）
      rule.ts,
      // UUID（十六进制见下面与 shell 输出预设共用的 rule.hex）
      { keyword: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', color: 'magenta' },
      // 十六进制与 shell 输出预设共用同一条（同色 magenta，含 \x… 转义）
      rule.hex,
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
