// Web 自定义头 / Cookie（S2-5）：整形规则是纯函数，主进程的落点是源码契约
// （那里依赖 electron，node 里跑不起来）。
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let mod

before(async () => {
  mod = await import('../../../src/client/components/web/web-headers.js')
})

describe('parseHeaderLines', () => {
  it('parses one header per line and ignores blanks/comments', () => {
    const out = mod.parseHeaderLines(`
      # 注释不算头
      Authorization: Bearer abc
      X-Api-Key: k1
    `)
    assert.deepEqual(out, { Authorization: 'Bearer abc', 'X-Api-Key': 'k1' })
  })

  it('splits on the first colon so values may contain colons', () => {
    assert.deepEqual(mod.parseHeaderLines('Authorization: Bearer a:b:c'),
      { Authorization: 'Bearer a:b:c' })
    assert.deepEqual(mod.parseHeaderLines('X-Trace: http://x/y'),
      { 'X-Trace': 'http://x/y' })
  })

  it('drops malformed lines instead of guessing', () => {
    const out = mod.parseHeaderLines([
      'no colon here',
      ': no name',
      'Bad Name: v',
      'X-Ok: '
    ].join('\n'))
    assert.deepEqual(out, {})
  })

  it('never lets one line become two headers', () => {
    // 值里塞换行只会被拆成"用户自己写的两条头"，不会带出第三条
    const out = mod.parseHeaderLines('X-A: v\r\nX-B: 1')
    assert.deepEqual(out, { 'X-A': 'v', 'X-B': '1' })
  })

  it('returns an empty object for empty input', () => {
    assert.deepEqual(mod.parseHeaderLines(''), {})
    assert.deepEqual(mod.parseHeaderLines(null), {})
  })
})

describe('buildCookieHeader', () => {
  it('joins name=value lines with "; "', () => {
    assert.equal(mod.buildCookieHeader('a=1\nb=2'), 'a=1; b=2')
    assert.equal(mod.buildCookieHeader('  a=1  \n\n# c\n'), 'a=1')
  })

  it('skips lines that are not name=value or carry separators', () => {
    assert.equal(mod.buildCookieHeader('no-equals\na=1; b=2\n:empty\n'), '')
  })

  it('returns an empty string for empty input', () => {
    assert.equal(mod.buildCookieHeader(''), '')
    assert.equal(mod.buildCookieHeader(null), '')
  })
})

describe('hasWebCustomHeaders', () => {
  it('detects any usable header or cookie', () => {
    assert.equal(mod.hasWebCustomHeaders({ webHeaders: 'A: 1' }), true)
    assert.equal(mod.hasWebCustomHeaders({ webCookies: 'a=1' }), true)
    assert.equal(mod.hasWebCustomHeaders({ webHeaders: '# only comment' }), false)
    assert.equal(mod.hasWebCustomHeaders({}), false)
    assert.equal(mod.hasWebCustomHeaders(null), false)
  })
})

describe('main process wiring (source contract)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/app/lib/webview-handler.js'),
    'utf8'
  )
  const preload = fs.readFileSync(
    path.join(__dirname, '../../../src/app/preload/preload.js'),
    'utf8'
  )

  it('registers the headers channel and merges per webContents', () => {
    assert.match(src, /ipcMain\.on\('webview-headers'/)
    assert.match(src, /headersMap\.get\(wcId\)/)
    assert.match(src, /headersMap\.delete\(viewWebContents\.id\)/)
    // 改不了的头不能放进去（Host/Content-Length 会被网络栈直接拒）
    assert.match(src, /IMPOSSIBLE_HEADERS/)
  })

  it('exposes setWebviewHeaders to the renderer', () => {
    assert.match(preload, /setWebviewHeaders/)
    assert.match(preload, /webview-headers/)
  })

  it('sends headers before reloading the webview', () => {
    const web = fs.readFileSync(
      path.join(__dirname, '../../../src/client/components/web/web-session.jsx'),
      'utf8'
    )
    assert.match(web, /setWebviewHeaders/)
    assert.match(web, /dom-ready/)
    // 注入成功后才 reload，否则白刷一次
    assert.match(web, /window\.api\.setWebviewHeaders\({ id, headers, cookie }\)\n\s+el\.reload\(\)/)
  })
})
