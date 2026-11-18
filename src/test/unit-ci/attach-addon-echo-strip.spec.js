const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// 注入窗口回放只剥注入命令自己的回显行，其余回显（banner 碎片等）必须
// 原样上屏；流控 bytes 按原 ws 帧全额保留（空片段 str='' 走纯 ACK 通道）。
// 曾因「整窗原样回放」把 typed 注入脚本打进屏幕（#4737 的显示层根源）。
global.window = {
  xtermAddons: {},
  et: { isWin: false, isMac: false },
  store: { triggerResize: () => {}, recState: {}, config: {} },
  initFolder: ''
}

const load = () => import('../../client/components/terminal/attach-addon-custom.js')
const loadShell = () => import('../../client/components/terminal/shell.js')

const joined = chunks => chunks.map(c => c.str).join('')

describe('filterSuppressedEcho: strips only the injected line', () => {
  test('removes the echoed command line, keeps everything else', async () => {
    const { filterSuppressedEcho } = await load()
    const needle = " eval 'x=1'\r".replace(/\r$/, '')
    const chunks = [
      { str: 'banner tail \r\n', bytes: 14 },
      { str: `${needle}\r\n`, bytes: needle.length + 2 },
      { str: 'user@host:~$ ', bytes: 13 }
    ]
    const out = filterSuppressedEcho(chunks, needle)
    assert.equal(joined(out), 'banner tail \r\nuser@host:~$ ')
    // bytes 全额保留：流控按原帧 ACK
    assert.deepEqual(out.map(c => c.bytes), [14, needle.length + 2, 13])
    // 被剥空的 chunk 走 str='' + bytes>0 纯 ACK 通道
    assert.equal(out[1].str, '')
    assert.equal(out[1].bytes, needle.length + 2)
  })

  test('keeps chunks intact when the needle spans a chunk boundary', async () => {
    const { filterSuppressedEcho } = await load()
    const needle = " eval 'abc;def'\r".replace(/\r$/, '')
    const echo = `${needle}\r\n`
    const cut = Math.floor(echo.length / 2)
    const chunks = [
      { str: echo.slice(0, cut), bytes: cut },
      { str: echo.slice(cut), bytes: echo.length - cut }
    ]
    const out = filterSuppressedEcho(chunks, needle)
    assert.equal(joined(out), '')
    assert.deepEqual(out.map(c => c.bytes), [cut, echo.length - cut])
  })

  test('does not strip when the echo is missing or shaped oddly', async () => {
    const { filterSuppressedEcho } = await load()
    const needle = " eval 'x=1'"
    const chunks = [{ str: 'some banner\r\n', bytes: 13 }]
    assert.equal(filterSuppressedEcho(chunks, needle), chunks)
    assert.equal(filterSuppressedEcho(chunks, ''), chunks)
    assert.equal(filterSuppressedEcho(chunks, null), chunks)
    const empty = []
    assert.equal(filterSuppressedEcho(empty, needle), empty)
  })

  test('strips up to \\r when no \\n follows the echo', async () => {
    const { filterSuppressedEcho } = await load()
    const needle = " eval 'x=1'"
    const chunks = [{ str: `${needle}\ruser@host:~$ `, bytes: 24 }]
    const out = filterSuppressedEcho(chunks, needle)
    assert.equal(joined(out), 'user@host:~$ ')
  })

  test('strips to the end of the buffer when the window closes mid-echo', async () => {
    const { filterSuppressedEcho } = await load()
    const needle = " eval 'x=1'"
    const chunks = [{ str: `pre ${needle}`, bytes: 16 }]
    const out = filterSuppressedEcho(chunks, needle)
    assert.equal(joined(out), 'pre ')
    assert.equal(out[0].bytes, 16)
  })
})

describe('filterSuppressedEcho: real injection command', () => {
  test('strips the typed bash one-liner verbatim', async () => {
    const [{ filterSuppressedEcho }, { getShellIntegrationCommand }] = await Promise.all([
      load(),
      loadShell()
    ])
    const cmd = getShellIntegrationCommand('bash')
    assert.ok(cmd.endsWith('\r'))
    const needle = cmd.replace(/\r+$/, '')
    // 回显里单引号转义序列原样出现
    assert.ok(needle.includes("'\\''"))
    const chunks = [
      { str: 'Last login: Fri\r\n', bytes: 17 },
      { str: `${needle}\r\n`, bytes: needle.length + 2 }
    ]
    const out = filterSuppressedEcho(chunks, needle)
    assert.equal(joined(out), 'Last login: Fri\r\n')
    assert.deepEqual(out.map(c => c.bytes), [17, needle.length + 2])
  })

  test('does not swallow a second occurrence of unrelated text', async () => {
    const { filterSuppressedEcho } = await load()
    const needle = " eval 'x=1'"
    // 注入回显之后，命令输出里又出现同样文本：只剥回显那处
    const chunks = [
      { str: `${needle}\r\n`, bytes: 24 },
      { str: `output: ${needle}\n`, bytes: 24 }
    ]
    const out = filterSuppressedEcho(chunks, needle)
    assert.equal(joined(out), 'output:  eval \'x=1\'\n')
  })

  test('strips the injected line when readline echoes it twice (copy/reconnect)', async () => {
    // 真 pty 回显：bash 行编辑器会把 eval 行回显两次，且第一次回显后跟 \r\n。
    // 复制会话 = 新 pty 重新注入，此时 readline 二次回显让 needle 原文只匹配
    // 到第一处、行尾落在第一个 \n，第二个回显行漏到屏幕——旧实现只剥第一处。
    // 双标记指纹兜底把两个回显行都剥掉。用真实注入命令构造，两处回显都含
    // `eval 'if [[` + `ELECTERM_SHELL_INTEGRATION` 双标记。
    const [{ filterSuppressedEcho }, { getShellIntegrationCommand }] = await Promise.all([
      load(),
      loadShell()
    ])
    const cmd = getShellIntegrationCommand('bash')
    const needle = cmd.replace(/\r+$/, '')
    const echo = `${needle}\r\n`
    const chunks = [
      { str: `banner\r\n${echo}${echo}`, bytes: 14 + echo.length * 2 },
      { str: 'user@host:~$ ', bytes: 13 }
    ]
    const out = filterSuppressedEcho(chunks, needle)
    assert.equal(joined(out), 'banner\r\nuser@host:~$ ')
    assert.deepEqual(out.map(c => c.bytes), [14 + echo.length * 2, 13])
  })

  test('strips injected line via fingerprint when the echo differs from the typed needle', async () => {
    // 远端/旧版注入脚本回显与本地原文不一致（引号转义、chunk 被提示符碎片打断），
    // needle 原文找不到——双标记指纹（eval 'if [[ + ELECTERM_SHELL_INTEGRATION）
    // 仍能定位并剥掉整行。
    const { filterSuppressedEcho } = await load()
    const chunks = [
      { str: 'banner\r\n', bytes: 8 },
      { str: " eval 'if [[ -z \"$" + '{ELECTERM_SHELL_INTEGRATION:-}' + "\" ]]'\r\n", bytes: 55 },
      { str: 'user@host:~$ ', bytes: 13 }
    ]
    const out = filterSuppressedEcho(chunks, null)
    assert.equal(joined(out), 'banner\r\nuser@host:~$ ')
  })

  test('fingerprint fallback does not strip a user command that mentions the env var', async () => {
    // 用户真实命令同时含 eval 'if [[ 与指纹串的概率极低，但必须确认不误杀：
    // 单标记（只有指纹串）不触发，双标记要同一行内两串都存在。
    const { filterSuppressedEcho } = await load()
    const chunks = [
      { str: 'banner\r\n', bytes: 8 },
      { str: 'echo $ELECTERM_SHELL_INTEGRATION\r\n', bytes: 35 },
      { str: 'user@host:~$ ', bytes: 13 }
    ]
    const out = filterSuppressedEcho(chunks, null)
    assert.equal(joined(out), 'banner\r\necho $ELECTERM_SHELL_INTEGRATION\r\nuser@host:~$ ')
  })
})
