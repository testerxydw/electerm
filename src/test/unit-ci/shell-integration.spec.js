const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const load = () => import('../../client/components/terminal/shell.js')
const loadTracker = () => import('../../client/components/terminal/command-tracker-addon.js')

// Issue #4610: telnet to a Huawei VRP switch. The remote `$SHELL` probe was
// answered with a CLI error banner, which was read as "some sh-compatible
// shell", so the PS1 integration script was typed into a device that cannot
// run `eval`. The device echoed it, the screen stayed frozen for the whole
// suppression window and the text ended up in the scrollback.
describe('remote shell probe parsing', () => {
  test('reads a normal shell path', async () => {
    const { parseRemoteShell } = await load()
    assert.equal(parseRemoteShell('/bin/bash\n'), 'bash')
    assert.equal(parseRemoteShell('/usr/local/bin/zsh'), 'zsh')
    assert.equal(parseRemoteShell('/usr/bin/fish\n'), 'fish')
    assert.equal(parseRemoteShell('/bin/dash\n'), 'sh')
  })

  test('is not fooled by an error banner or a prompt', async () => {
    const { parseRemoteShell } = await load()
    // Huawei VRP answers an unknown command like this
    assert.equal(parseRemoteShell('Error: Unrecognized command found at \'^\' position.\n'), '')
    assert.equal(parseRemoteShell('<HUAWEI>'), '')
    assert.equal(parseRemoteShell('% Invalid input detected\n'), '')
    // empty answer: $SHELL unset, or the command was swallowed
    assert.equal(parseRemoteShell(''), '')
    assert.equal(parseRemoteShell('   \r\n'), '')
    assert.equal(parseRemoteShell(undefined), '')
  })
})

describe('shell detection', () => {
  test('recognizes PowerShell, including a full path and pwsh', async () => {
    const { detectShellType } = await load()
    for (const shell of [
      'powershell',
      'powershell.exe',
      'pwsh',
      'pwsh.exe',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"'
    ]) {
      assert.equal(detectShellType(shell), 'powershell', shell)
    }
  })

  // cmd is detected only so that nothing is injected into it: it cannot run any
  // script we have, and the POSIX `sh` default used to be the wrong answer.
  test('detects cmd without falling back to sh', async () => {
    const { detectShellType, shellIntegrationTypes } = await load()
    assert.equal(detectShellType('System32/cmd.exe'), 'cmd')
    assert.equal(detectShellType('C:\\Windows\\System32\\cmd.exe'), 'cmd')
    assert.equal(shellIntegrationTypes.has('cmd'), false)
  })

  test('leaves the POSIX detection alone', async () => {
    const { detectShellType } = await load()
    assert.equal(detectShellType('/bin/bash'), 'bash')
    assert.equal(detectShellType('/bin/zsh'), 'zsh')
    assert.equal(detectShellType('/usr/bin/fish'), 'fish')
    assert.equal(detectShellType('/bin/dash'), 'sh')
    assert.equal(detectShellType(''), 'sh')
    assert.equal(detectShellType(undefined), 'sh')
  })
})

// #4737: PowerShell has no PROMPT_COMMAND, so the prompt function is wrapped.
// It is what tells the app the live cwd a ctrl+clicked relative path is
// resolved against. A Windows local pty gets the script as a spawn argument
// (see powershell-spawn-integration.spec.js); typing it is only left for `pwsh`
// used as a local shell on macOS/Linux.
describe('PowerShell shell integration', () => {
  test('is sent raw and reports the cwd from the prompt', async () => {
    const { getShellIntegrationCommand } = await load()
    const cmd = getShellIntegrationCommand('powershell')
    // `eval '...'` is bash syntax, not PowerShell
    assert.equal(cmd.includes("eval '"), false)
    assert.equal(cmd.endsWith('\r'), true)
    assert.match(cmd, /ELECTERM_SHELL_INTEGRATION/)
    assert.match(cmd, /633;P;Cwd=/)
    assert.match(cmd, /633;A/)
    // the path is escaped the way OSC 633 expects (`\` -> `\\`, `;` -> `\x3b`)
    assert.ok(cmd.includes(String.raw`.Replace('\','\\')`), 'doubles the backslashes')
    assert.ok(cmd.includes(String.raw`.Replace(';','\x3b')`), 'escapes the semicolons')
    // and the user's own prompt still has to be drawn, before anything is
    // written: oh-my-posh reads `$?` first, and [Console]::Write resets it
    assert.ok(
      cmd.includes('$x=if($global:__e_prompt){& $global:__e_prompt}else{'),
      'calls the original prompt first'
    )
    // the same string travels as one command line argument to powershell.exe
    assert.equal(cmd.includes('"'), false, 'no double quotes')
  })
})

describe('OSC 633 value unescaping', () => {
  const deserialize = async (value) => {
    const { CommandTrackerAddon } = await loadTracker()
    return new CommandTrackerAddon()._deserializeOscValue(value)
  }

  test('collapses escaped backslashes', async () => {
    assert.equal(await deserialize('D:\\\\work\\\\project'), 'D:\\work\\project')
  })

  test('decodes escaped semicolons', async () => {
    assert.equal(await deserialize('E:\\\\a\\x3bb'), 'E:\\a;b')
  })

  // A Windows path may contain the characters `\x` followed by hex digits. The
  // old two-pass version decoded `\x..` *before* collapsing `\\`, so `D:\\x86`
  // came back as `D:V`: every path with a directory starting with `x`+hex broke.
  test('does not read a real backslash as the start of an escape', async () => {
    assert.equal(await deserialize('D:\\\\x86\\\\build'), 'D:\\x86\\build')
    assert.equal(await deserialize('C:\\\\x41bc'), 'C:\\x41bc')
  })

  test('keeps a lone backslash and unknown escapes as they are', async () => {
    assert.equal(await deserialize('C:\\work\\z'), 'C:\\work\\z')
    assert.equal(await deserialize('a\\qb'), 'a\\qb')
    assert.equal(await deserialize(''), '')
  })

  test('round-trips a path containing a semicolon', async () => {
    const { CommandTrackerAddon } = await loadTracker()
    const path = 'D:\\work;x\\[a]\\b'
    const escaped = path.replace(/\\/g, '\\\\').replace(/;/g, '\\x3b')
    assert.equal(new CommandTrackerAddon()._deserializeOscValue(escaped), path)
  })
})

// 注入命令本身（含 ELECTERM_SHELL_INTEGRATION 指纹串）既不能进 electerm 的
// 命令历史（633;E 上报），也不能进远端 shell 的 history（主机 HISTCONTROL
// 没配 ignorespace 时前导空格挡不住，RHEL 默认只有 ignoredups）。
describe('injected line stays out of history and reports', () => {
  test('bash script guards 633;E and self-deletes from history', async () => {
    const { getInlineShellIntegration } = await load()
    // 断言用未包装的内联脚本：wrapSilent 会把 `'` 转义成 `'\''`，
    // 含引号的新指纹在包装文本里匹配不到
    const cmd = getInlineShellIntegration('bash')
    // 指纹收窄为注入行专属签名（eval 'if [[ + 指纹串双标记）：只含指纹串的
    // 真实用户命令（如 echo $ELECTERM_SHELL_INTEGRATION）不能被误杀
    assert.ok(
      cmd.includes("[[ \"$BASH_COMMAND\" == *\"eval 'if [[\"*ELECTERM_SHELL_INTEGRATION* ]] && return"),
      'DEBUG trap never reports the injected line'
    )
    // 每个 prompt 都检查末条：bash 启动时的首个 prompt 会先跑一次
    // PROMPT_COMMAND，一次性标记会被它消耗掉，注入行反而删不到
    assert.ok(cmd.includes('h=$(history 1 2>/dev/null)'), 'checks the last entry on every prompt')
    assert.ok(cmd.includes('history -d "$hn"'), 'deletes the injected entry')
  })

  test('zsh script guards preexec and vetoes via zshaddhistory', async () => {
    const { getInlineShellIntegration } = await load()
    const cmd = getInlineShellIntegration('zsh')
    assert.ok(
      cmd.includes('__e_preexec() { [[ "$1" == *"eval \'if [["*ELECTERM_SHELL_INTEGRATION* ]] && return;'),
      'preexec never reports the injected line'
    )
    assert.ok(
      cmd.includes('zshaddhistory() { [[ "$1" == *"eval \'if [["*ELECTERM_SHELL_INTEGRATION* ]] && return 1'),
      'zshaddhistory vetoes the injected line'
    )
  })

  test('fish script guards preexec', async () => {
    const { getShellIntegrationCommand } = await load()
    const cmd = getShellIntegrationCommand('fish')
    assert.ok(
      cmd.includes("string match -q -- '*ELECTERM_SHELL_INTEGRATION*'"),
      'fish preexec never reports the injected line'
    )
  })

  // 真 shell 子进程回归：history 行为（append 先于 PROMPT_COMMAND、
  // zshaddhistory 否决语义）只有真进程能验证，假实现/时序假设变化在这里拦截
  const hasShell = (sh) => {
    try {
      execFileSync('sh', ['-c', `command -v ${sh} >/dev/null 2>&1`])
      return true
    } catch (e) {
      return false
    }
  }

  const runHistoryProbe = async (sh, args, integrationCmd, dumpCmd) => {
    // 临时目录 + 跑完直删（AGENTS.md §1/§2，不进回收站）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-histprobe-'))
    const histFile = path.join(dir, 'hist')
    try {
      const child = spawn(sh, args, {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, TERM: 'dumb' }
      })
      child.stdin.write(integrationCmd)
      child.stdin.write('echo REALCMD_OK\n')
      child.stdin.write(`${dumpCmd} ${histFile}\n`)
      child.stdin.write('exit\n')
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
      const [code] = await once(child, 'close')
      clearTimeout(timer)
      if (code === null || code === 137) {
        return null // probe hung or was killed
      }
      return fs.readFileSync(histFile, 'utf8')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test('real bash: injected line never lands in history', { skip: !hasShell('bash') }, async () => {
    const { getShellIntegrationCommand } = await load()
    const content = await runHistoryProbe(
      'bash', ['--noprofile', '--norc', '-i'],
      getShellIntegrationCommand('bash'), 'history -w'
    )
    assert.ok(content, 'bash probe finished within timeout')
    assert.match(content, /echo REALCMD_OK/, 'real user command stays in history')
    assert.doesNotMatch(content, /ELECTERM_SHELL_INTEGRATION/, 'injected line removed from history')
  })

  test('real zsh: zshaddhistory vetoes the injected line', { skip: !hasShell('zsh') }, async () => {
    const { getShellIntegrationCommand } = await load()
    const content = await runHistoryProbe(
      'zsh', ['-f', '-i'],
      getShellIntegrationCommand('zsh'), 'fc -W'
    )
    assert.ok(content, 'zsh probe finished within timeout')
    assert.match(content, /echo REALCMD_OK/, 'real user command stays in history')
    assert.doesNotMatch(content, /ELECTERM_SHELL_INTEGRATION/, 'injected line never entered history')
  })
})

describe('OSC 633;E fingerprint filter', () => {
  test('does not report the injected line, keeps normal commands', async () => {
    const { CommandTrackerAddon } = await loadTracker()
    const addon = new CommandTrackerAddon()
    const seen = []
    addon.onCommandExecuted(cmd => seen.push(cmd))
    // 注入行签名（eval 'if [[ + 指纹串双标记），无反斜杠无分号保证 _deserializeOscValue 恒等
    addon._handleOsc633("E; eval 'if [[ $- == *i* ]] && [[ -z \"${ELECTERM_SHELL_INTEGRATION:-}\" ]]")
    assert.deepEqual(seen, [], 'injected line never reaches the history callback')
    assert.equal(addon.reportedCommand, true, 'OSC channel still counts as working')
    addon._handleOsc633('E;ls -la')
    assert.deepEqual(seen, ['ls -la'], 'normal commands are reported')
  })

  test('real command merely mentioning the fingerprint is not dropped', async () => {
    const { CommandTrackerAddon } = await loadTracker()
    const addon = new CommandTrackerAddon()
    const seen = []
    addon.onCommandExecuted(cmd => seen.push(cmd))
    // 探针实机曾暴露：宽匹配会误杀 echo $ELECTERM_SHELL_INTEGRATION 这类命令
    addon._handleOsc633('E;echo $ELECTERM_SHELL_INTEGRATION')
    assert.deepEqual(seen, ['echo $ELECTERM_SHELL_INTEGRATION'], 'user command mentioning the var name is kept')
    assert.equal(addon.reportedCommand, true, 'OSC channel still counts as working')
  })
})
