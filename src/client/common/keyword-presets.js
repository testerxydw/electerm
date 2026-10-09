/**
 * Built-in keyword highlight presets, offered next to keyword import/export.
 * Applying a preset adds its rules after the user's existing ones (skipping
 * rules already present), so it never discards custom keywords.
 */

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
      // 前后排除引号和冒号,避免误伤 JSON 键名("errors":0 / "denied_count")
      { keyword: '(?<![":])\\b(errors?|fail(ed|ure|s)?|denied|deny|invalid|incomplete|unreachable|timeout|timed out|crc|runts|giants|collisions?|input errors|output errors|discard(s|ed)?|drop(s|ped)?|blocking|blk|bkn|broken|alarm|critical|access denied)\\b(?![":])', color: 'red' },
      { keyword: '(?<![":])\\b(up|connected|link up|permit(ted)?|forwarding|fwd|full|established|active|success(ful)?|enabled?|ok|online|reachable|root)\\b(?![":])|\\bu/u\\b', color: 'green' },
      { keyword: '(?<![":])\\b(warning|warn|half|learning|lrn|listening|lis|standby|disabled?|shutdown|pending|unknown|desg|altn|alternate|backup)\\b(?![":])', color: 'yellow' },
      // MAC addresses: aa:bb:cc:dd:ee:ff, aa-bb-..., aabb.ccdd.eeff
      { keyword: '\\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b|\\b[0-9a-f]{4}\\.[0-9a-f]{4}\\.[0-9a-f]{4}\\b', color: 'magenta' },
      // IPv4 with optional prefix length
      { keyword: '\\b(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}(/\\d{1,2})?\\b', color: 'cyan' },
      // interface names. Cisco/Arista/Dell: Gi1/0/1, GigabitEthernet1/0/1, Et1, Ma1, Po1, Vlan600.
      // Huawei: XGigabitEthernet0/0/1, 40GE1/0/1, Eth-Trunk1, Vlanif10. HP Comware: XGE1/0/1,
      // Bridge-Aggregation1, BAGG1. ProCurve: Trk1. MikroTik: ether1, sfp-sfpplus1, bridge1.
      // Ubiquiti EdgeOS: eth0, eth1.100, switch0, br0
      { keyword: '\\b(GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|XGigabitEthernet|FastEthernet|Ethernet|Eth-Trunk|Port-channel|Bridge-Aggregation|Route-Aggregation|Management|Loopback|Tunnel|MEth|Vlanif|Vlan|BAGG|sfp-sfpplus|sfp|ether|switch|bridge|bond|wlan|pppoe|Trk|ae|br|XGE|FGE|GE|Gi|Te|Twe|Fo|Hu|Fa|Eth|Et|Ma|Po|Lo|Tu|Vl|\\d{2,3}GE)\\s?\\d+(/\\d+){0,3}(\\.\\d+)?\\b', color: 'blue' },
      // Juniper: ge-0/0/0, xe-0/0/1.0, et-0/0/2, irb.100, em0, fxp0
      { keyword: '\\b(ge|xe|et|fe|mge|lt|gr)-\\d+/\\d+/\\d+(\\.\\d+)?\\b|\\birb(\\.\\d+)?\\b|\\b(em|fxp|me)\\d+\\b', color: 'blue' },
      // slot/port: 1/1, HPE Aruba CX 1/1/1; Hirschmann cpu/1, lag/1
      { keyword: '\\b(cpu|vlan|lag|ch)\\s?/?\\d+(/\\d+)?\\b|\\b\\d/\\d{1,2}(/\\d{1,2})?\\b', color: 'blue' }
    ]
  },
  {
    name: 'Log Levels',
    description: 'Generic application logs: severity words used by most frameworks and shippers (log4j/logback, zap, pino, logrus, syslog clients, nginx/error.log)',
    keywords: [
      { keyword: '\\b(FATAL|PANIC)\\b', color: 'red' },
      { keyword: '\\b(ERROR|ERR)\\b', color: 'red' },
      { keyword: '\\b(WARN|WARNING)\\b', color: 'yellow' },
      { keyword: '\\b(INFO|NOTICE)\\b', color: 'cyan' },
      { keyword: '\\b(DEBUG|TRACE|VERBOSE)\\b', color: 'blue' }
    ]
  },
  {
    name: 'Timestamps',
    description: 'Common timestamp shapes: ISO 8601, classic BSD syslog dates, bracketed timers and bare clock times',
    keywords: [
      // 排除 JSON 字段值中的时间戳(前后有 ":"")
      { keyword: '(?<![":])\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?(?![":])', color: 'magenta' },
      { keyword: '\\b(?:mon|tue|wed|thu|fri|sat|sun)\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\b', color: 'cyan' },
      { keyword: '\\[\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\]', color: 'cyan' },
      { keyword: '(?<![":])\\b\\d{2}:\\d{2}:\\d{2}\\b(?![":])', color: 'blue' }
    ]
  },
  {
    name: 'Exceptions & Stack Traces',
    description: 'Crash signatures: Java exceptions and frames, Python tracebacks, Go panics and native signal aborts',
    keywords: [
      { keyword: '\\b(?:[\\w$]+\\.)*[A-Z][\\w$]*(?:Exception|Error)\\b', color: 'red' },
      { keyword: '\\bCaused by:', color: 'red' },
      { keyword: '\\bat [\\w$.]+\\([^)]*\\)', color: 'blue' },
      { keyword: 'Traceback \\(most recent call last\\)', color: 'red' },
      { keyword: 'File "[^"]+", line \\d+', color: 'yellow' },
      { keyword: '\\b(SIGSEGV|SIGABRT|SIGKILL|core dumped)\\b', color: 'red' },
      { keyword: '\\bpanic:', color: 'red' }
    ]
  },
  {
    name: 'Containers & Kubernetes',
    description: 'kubectl / Docker status vocabulary: pod phases and restart reasons across get events, describe and CI logs',
    keywords: [
      { keyword: '\\b(CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|Evicted|OOMKilled|Failed)\\b', color: 'red' },
      { keyword: '\\b(Running|Completed|Succeeded|Ready|Healthy)\\b', color: 'green' },
      { keyword: '\\b(Pending|ContainerCreating|ContainerStatusUnknown|Terminating|Progressing)\\b', color: 'yellow' },
      { keyword: '\\b(?:pod|deployment|daemonset|statefulset|replicaset|service|ingress|configmap|secret|namespace)/[\\w.-]+', color: 'blue' }
    ]
  },
  {
    name: 'Git & VCS',
    description: 'Git CLI output: conflict markers, fatal errors, merge/rebase state and commit hashes',
    keywords: [
      { keyword: '<{7}|={7}|>{7}', color: 'red' },
      { keyword: '\\bfatal:', color: 'red' },
      { keyword: '\\bconflict(?:s|ed)?\\b', color: 'red' },
      { keyword: '\\b(staged|untracked|detached HEAD|fast-forward|rebasing|merging|bisect)\\b', color: 'cyan' },
      { keyword: '\\bcommit [0-9a-f]{7,40}\\b', color: 'magenta' }
    ]
  },
  {
    name: 'Build & Test',
    description: 'Compilers, bundlers and test runners: error/warning counts, build results, check marks and npm error lines',
    keywords: [
      { keyword: '\\b\\d+ errors?\\b', color: 'red' },
      { keyword: '\\b\\d+ warnings?\\b', color: 'yellow' },
      { keyword: '\\berror TS\\d+:', color: 'red' },
      { keyword: '\\bBUILD (?:SUCCESS|SUCCESSFUL)\\b', color: 'green' },
      { keyword: '\\bBUILD (?:FAILED|FAILURE)\\b', color: 'red' },
      { keyword: '\\b\\d+ (?:passed|passing)\\b', color: 'green' },
      { keyword: '\\b\\d+ (?:failed|failing)\\b', color: 'red' },
      { keyword: '[✔✓]', color: 'green' },
      { keyword: '[✘✗]', color: 'red' },
      { keyword: '\\bnpm (?:ERR|WARN)!', color: 'red' }
    ]
  },
  {
    name: 'Security & Auth',
    description: 'Auth and access-control signals: denials, SSH auth.log lines, web error statuses and sudo events',
    keywords: [
      { keyword: '\\b(permission denied|access denied|unauthorized|forbidden|authentication fail\\w*|auth fail\\w*|invalid credentials?)\\b', color: 'red' },
      { keyword: '\\b(Failed password|Invalid user)\\b', color: 'red' },
      { keyword: '\\b(Internal Server Error|Bad Gateway|Service Unavailable)\\b', color: 'red' },
      { keyword: '\\b(Accepted password|Accepted publickey|session opened)\\b', color: 'green' },
      { keyword: '\\bNot Found\\b', color: 'yellow' },
      { keyword: '\\bsudo:', color: 'yellow' }
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
