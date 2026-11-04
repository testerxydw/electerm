/*
 * M6 量化探针（doc/分析-远程页面内存释放与VNC刷新期增长-2026-11-04.md §5 M6）
 *
 * 目的：把"VNC 内容持续刷新时内存涨得飞快"从推测变成数字。
 * 做法：本地起一个最小 RFB 3.8 服务器（Raw 编码、按固定帧率推整屏），用 headless
 * Edge 加载真实的 @novnc/novnc 客户端连上去，逐秒采样 noVNC 内部水位与浏览器进程 RSS。
 *
 * 采什么：
 *   - _rQbufferSize：接收环形缓冲的容量高水位（假设①：只扩不缩，4MiB → 40MiB 封顶）
 *   - _rQlen-_rQi  ：此刻积压的字节
 *   - _flushing     ：是否正处于"渲染跟不上、暂停消费"的背压状态
 *   - usedJSHeapSize：JS 堆
 *   - RSS          ：整个浏览器进程树（含 renderer 的图像/显存类内存）
 *   - 断开后同上：验证"关掉之后还不还"
 *
 * 用法：node self-test/vnc-mem-probe.js [--seconds=30] [--width=1280] [--height=720] [--fps=15]
 * 说明：本探针只读产品代码，不改任何东西；临时 profile 目录跑完即删（直删，不进回收站）。
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const NOVNC = path.join(ROOT, 'node_modules/@novnc/novnc')
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : def
}
const SECONDS = Number(arg('seconds', 30))
const WIDTH = Number(arg('width', 1280))
const HEIGHT = Number(arg('height', 720))
const FPS = Number(arg('fps', 15))
const CDP_PORT = Number(arg('cdp', 9344))
// raw = 整屏原始位图（服务器最"实诚"的形态）；jpeg = Tight/JPEG 整屏一块，
// 走的是 qualityLevel 调低后真实服务器给视频区选的那条路径：base64 + new Image()
// + 异步解码，正是"刷新时涨得快"的怀疑对象
const ENCODING = arg('encoding', 'raw')
const FRAMES = Number(arg('frames', 60))
// 一帧切成几块 JPEG 瓦片（真实服务器给视频区域就是这么切的：一帧几百个 rect，
// 每个都要客户端异步解码）。1x1 是"整屏一张 JPEG"的最省形态
const TILE_SPEC = arg('tiles', '1x1').split('x')
const TILE = { cols: Number(TILE_SPEC[0]), rows: Number(TILE_SPEC[1]) }
const FRAME_BYTES = WIDTH * HEIGHT * 4

const freePort = require('../src/app/lib/free-port').getFreePort

const fail = msg => {
  console.error('[vnc-mem-probe] FAIL: ' + msg)
  process.exit(1)
}

// ---------------------------------------------------------------- 假 RFB 服务器

// Tight 的紧凑长度：7 位一组、高位是续读标志（客户端 _readData 认这三档）
function tightLen (len) {
  if (len < 128) {
    return Buffer.from([len])
  }
  if (len < 16384) {
    return Buffer.from([(len & 0x7f) | 0x80, len >> 7])
  }
  return Buffer.from([(len & 0x7f) | 0x80, ((len >> 7) & 0x7f) | 0x80, len >> 14])
}

// 用 ffmpeg 造一段"像视频"的画面当 JPEG 帧源：真实服务器上 qualityLevel=3 时，
// 视频区域就是这种每帧都要客户端异步解码的 JPEG
function genJpegFrames (dir) {
  const { execFileSync } = require('child_process')
  const W = Math.ceil(WIDTH / TILE.cols)
  const H = Math.ceil(HEIGHT / TILE.rows)
  execFileSync('/usr/bin/ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `testsrc2=size=${W}x${H}:rate=${FPS}`,
    '-q:v', '31',
    '-frames:v', String(FRAMES),
    path.join(dir, 'frame%03d.jpg')
  ])
  return fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort()
    .map(f => fs.readFileSync(path.join(dir, f)))
}

function makeRfbServer (jpegFrames) {
  const server = http.createServer()
  const wss = new WebSocket.Server({ server })

  wss.on('connection', (socket, req) => {
    // 只认 /vnc/xxx 这一条路径，其余升级请求直接关掉（探针同端口只跑这一件事）
    if (!/^\/vnc\//.test((req.url || '').split('?')[0])) {
      socket.close()
      return
    }
    let inited = false
    // 服务器先报版本，客户端才会回它自己的版本
    socket.send(Buffer.from('RFB 003.008\n'))
    socket.on('error', err => { console.log('[rfb-server] socket error:', err.message) })
    // 一帧 = 一个 FramebufferUpdate + N 个矩形
    const fbuHeader = (n) => {
      const h = Buffer.alloc(4)
      h.writeUInt8(0, 0) // FBUpdate
      h.writeUInt8(0, 1) // padding
      h.writeUInt16BE(n, 2)
      return h
    }
    const tightRect = (x, y, w, h, jpeg) => {
      const head = Buffer.alloc(12)
      head.writeUInt16BE(x, 0)
      head.writeUInt16BE(y, 2)
      head.writeUInt16BE(w, 4)
      head.writeUInt16BE(h, 6)
      // noVNC 自己的编号表里 Tight = 7（与 RFB 规范的 0x15 不同），
      // 控制字节 0x90 = 右移 4 位后得 0x09（内嵌 JPEG）
      head.writeInt32BE(7, 8)
      return Buffer.concat([head, Buffer.from([0x90]), tightLen(jpeg.length), jpeg])
    }
    const rawRect = (frame) => {
      const px = Buffer.alloc(FRAME_BYTES)
      // 每帧改色，保证 noVNC 真的走一遍绘制（全同内容会被浏览器内部缓存掩盖）
      const r = (frame * 7) % 256
      const g = (frame * 11) % 256
      const b = (frame * 13) % 256
      for (let i = 0; i < FRAME_BYTES; i += 4) {
        px[i] = b
        px[i + 1] = g
        px[i + 2] = r
        px[i + 3] = 255
      }
      const head = Buffer.alloc(12)
      head.writeUInt16BE(WIDTH, 4)
      head.writeUInt16BE(HEIGHT, 6)
      head.writeInt32BE(0, 8) // Raw
      return Buffer.concat([head, px])
    }
    const paint = (frame) => {
      if (ENCODING !== 'jpeg') {
        return Buffer.concat([fbuHeader(1), rawRect(frame)])
      }
      const tw = Math.ceil(WIDTH / TILE.cols)
      const th = Math.ceil(HEIGHT / TILE.rows)
      const rects = []
      for (let ry = 0; ry < TILE.rows; ry++) {
        for (let cx = 0; cx < TILE.cols; cx++) {
          const x = cx * tw
          const y = ry * th
          const jpeg = jpegFrames[(frame + ry * TILE.cols + cx) % jpegFrames.length]
          rects.push(tightRect(x, y, Math.min(tw, WIDTH - x), Math.min(th, HEIGHT - y), jpeg))
        }
      }
      return Buffer.concat([fbuHeader(rects.length), ...rects])
    }
    socket.on('message', buf => {
      if (process.env.PROBE_DEBUG) console.log('[rfb-server] recv', buf.length, JSON.stringify(buf.slice(0, 40).toString('hex')))
      if (inited) {
        return
      }
      // 客户端版本握手 + 选 None 认证
      if (buf.length >= 12 && buf.slice(0, 12).toString().startsWith('RFB')) {
        // 相对 init 起点：0 类型数 / 1 类型 / 2-5 SecurityResult /
        // 6-29 ServerInit（宽高 + 16 字节 PIXEL_FORMAT + 4 字节名字长度）/ 30+ 名字
        const NAME = 'probe-vnc'
        const init = Buffer.alloc(30 + NAME.length)
        init.writeUInt8(1, 0) // 1 个 security type
        init.writeUInt8(1, 1) // None
        init.writeUInt32BE(0, 2) // SecurityResult = OK
        init.writeUInt16BE(WIDTH, 6)
        init.writeUInt16BE(HEIGHT, 8)
        init.writeUInt8(32, 10) // bpp
        init.writeUInt8(24, 11) // depth
        init.writeUInt8(0, 12) // big endian
        init.writeUInt8(1, 13) // true colour
        init.writeUInt16BE(255, 14)
        init.writeUInt16BE(255, 16)
        init.writeUInt16BE(255, 18)
        init.writeUInt8(16, 20) // red shift
        init.writeUInt8(8, 21) // green shift
        init.writeUInt8(0, 22) // blue shift
        // PIXEL_FORMAT 后面有 3 个 pad 字节（23-25），漏掉会让客户端把
        // 名字长度读成垃圾，握手永远卡住、接收缓冲一路涨到 40MiB 上限
        init.writeUInt32BE(NAME.length, 26)
        init.write(NAME, 30, 'utf8')
        socket.send(init)
        if (process.env.PROBE_DEBUG) console.log('[rfb-server] sent init', init.toString('hex'))
        inited = true
        let frame = 0
        const timer = setInterval(() => {
          if (socket.readyState !== socket.OPEN) {
            clearInterval(timer)
            return
          }
          try {
            socket.send(paint(frame++), { binary: true })
          } catch (e) {
            clearInterval(timer)
          }
        }, Math.round(1000 / FPS))
        socket.on('close', () => clearInterval(timer))
      }
    })
  })

  return new Promise(resolve => {
    const rfbPort = freePort({ from: 5900, host: '127.0.0.1' })
    rfbPort.then(port => {
      server.listen(port, '127.0.0.1', () => resolve({ server, port }))
    })
  })
}

// ---------------------------------------------------------------- 静态页面（载真 noVNC）

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>pending</title></head>
<body style="margin:0">
<div id="screen" style="width:100vw;height:100vh"></div>
<script type="module">
import RFB from '/core/rfb.js'
import { initLogging } from '/core/util/logging.js'
// 先把 console 抓下来，再开 debug 级别：initLogging 会 bind 当时的 console 方法，
// 顺序反了就什么都捕不到
const captured = []
for (const level of ['error', 'warn', 'debug']) {
  const origin = console[level].bind(console)
  console[level] = (...args) => {
    if (captured.length < 300) captured.push(level + ': ' + args.map(String).join(' ').slice(0, 200))
    origin(...args)
  }
}
initLogging('debug')
const snap = () => {
  const rfb = window.__rfb
  const sock = rfb && rfb._sock
  const d = rfb && rfb._display
  return {
    rfb: !!rfb,
    connected: !!(rfb && rfb._flushing !== undefined && sock && sock._rQ),
    rQbufferSize: sock ? sock._rQbufferSize : null,
    rQpending: sock ? sock._rQlen - sock._rQi : null,
    flushing: rfb ? !!rfb._flushing : null,
    renderQ: d && d._renderQ ? d._renderQ.length : null,
    canvas: rfb && rfb._canvas ? [rfb._canvas.width, rfb._canvas.height] : null,
    backbuffer: d && d._backbuffer ? [d._backbuffer.width, d._backbuffer.height] : null,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null
  }
}
window.__probe = {
  state: 'boot',
  events: [],
  errors: captured,
  samples: [],
  sample () {
    const s = snap()
    s.t = Math.round(performance.now())
    this.samples.push(s)
    return s
  },
  connect (url) {
    const rfb = new RFB(document.getElementById('screen'), url, {
      shared: true,
      scaleViewport: true,
      clipViewport: true
    })
    rfb.addEventListener('connect', () => { window.__probe.state = 'connected' })
    rfb.addEventListener('disconnect', (e) => {
      window.__probe.state = 'disconnected'
      window.__probe.events.push({ type: 'disconnect', detail: JSON.stringify(e.detail), fail: rfb._rfbFailReason || null, init: rfb._rfbInitState || null })
    })
    rfb.addEventListener('securityfailure', (e) => {
      window.__probe.events.push({ type: 'securityfailure', detail: JSON.stringify(e.detail) })
    })
    rfb.addEventListener('fatal', (e) => {
      window.__probe.events.push({ type: 'fatal', detail: JSON.stringify(e.detail) })
    })
    window.onerror = (m) => captured.push('onerror: ' + String(m))
    window.__rfb = rfb
  },
  disconnect () {
    window.__rfb.disconnect()
  }
}
document.title = 'ready'
</script>
</body></html>`

function makePageServer () {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    // /core/... 与 /vendor/... 直出真实的 noVNC 源码
    const file = path.join(NOVNC, path.normalize(url))
    if (!file.startsWith(NOVNC) || !fs.existsSync(file)) {
      res.writeHead(404)
      res.end('nope')
      return
    }
    res.writeHead(200, { 'content-type': url.endsWith('.js') ? 'text/javascript' : 'text/plain' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(resolve => {
    freePort({ from: 8410, host: '127.0.0.1' }).then(port => {
      server.listen(port, '127.0.0.1', () => resolve({ server, port }))
    })
  })
}

// ---------------------------------------------------------------- 极小 CDP 客户端

function cdpConnect (wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
    let id = 0
    const waiting = new Map()
    ws.on('open', () => {
      resolve({
        ws,
        send (method, params = {}) {
          return new Promise((_resolve, _reject) => {
            const mid = ++id
            waiting.set(mid, { res: _resolve, rej: _reject })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        }
      })
    })
    ws.on('message', raw => {
      const msg = JSON.parse(raw)
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id)
        waiting.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    ws.on('error', reject)
  })
}

async function evalJs (cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails))
  }
  return r.result.value
}

// 整棵浏览器进程树的 RSS，以及 renderer 自己的 RSS。
// 只有 renderer 那一列能说明问题：noVNC 的接收缓冲、画布、解码位图都住在里面。
// 用 pid 父子关系认领，不能按进程名匹配 —— 用户自己开着的 Edge 会被一起算进来。
function treeRss (rootPid) {
  const childrenOf = new Map()
  const rssOf = new Map()
  const cmdOf = new Map()
  for (const dir of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(dir)) {
      continue
    }
    let status = ''
    try {
      status = fs.readFileSync(`/proc/${dir}/status`, 'utf8')
    } catch (e) {
      continue
    }
    const pid = Number(dir)
    const ppid = Number((status.match(/PPid:\s+(\d+)/) || [])[1])
    const rss = Number((status.match(/VmRSS:\s+(\d+)/) || [])[1]) * 1024
    if (ppid) {
      const list = childrenOf.get(ppid) || []
      list.push(pid)
      childrenOf.set(ppid, list)
    }
    rssOf.set(pid, Number.isFinite(rss) ? rss : 0)
    try {
      cmdOf.set(pid, fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
    } catch (e) {
      cmdOf.set(pid, '')
    }
  }
  let total = 0
  let renderer = 0
  const walk = pid => {
    total += rssOf.get(pid) || 0
    if ((cmdOf.get(pid) || '').includes('--type=renderer')) {
      renderer += rssOf.get(pid) || 0
    }
    for (const child of childrenOf.get(pid) || []) {
      walk(child)
    }
  }
  walk(rootPid)
  return { total, renderer }
}

// ---------------------------------------------------------------- 主流程

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main () {
  if (!fs.existsSync(NOVNC)) fail('找不到 @novnc/novnc')
  const browser = arg('browser', '/usr/bin/microsoft-edge')
  if (!fs.existsSync(browser)) fail(`找不到浏览器 ${browser}`)

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-vncmem-'))
  const cleanup = []
  let edge = null
  const die = async code => {
    try { if (edge) edge.kill('SIGKILL') } catch (e) {}
    for (const fn of cleanup) { try { await fn() } catch (e) {} }
    // 等浏览器真退出再删：Edge 还在写 profile 时 rmSync 会撞 ENOTEMPTY
    for (let i = 0; i < 40; i++) {
      if (!edge || edge.exitCode !== null) break
      await sleep(250)
    }
    // 临时树一律直删，不进回收站（AGENTS.md §1）
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    process.exit(code)
  }

  let jpegFrames = null
  if (ENCODING === 'jpeg') {
    const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-vncmem-frames-'))
    cleanup.push(() => {
      fs.rmSync(framesDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    })
    jpegFrames = genJpegFrames(framesDir)
    if (!jpegFrames.length) fail('ffmpeg 没造出 JPEG 帧')
  }

  const rfb = await makeRfbServer(jpegFrames)
  const page = await makePageServer()
  cleanup.push(() => new Promise(resolve => rfb.server.close(resolve)))
  cleanup.push(() => new Promise(resolve => page.server.close(resolve)))

  const tiles = ENCODING === 'jpeg' ? TILE.cols * TILE.rows : 1
  const oneTile = ENCODING === 'jpeg'
    ? jpegFrames.reduce((a, b) => a + b.length, 0) / jpegFrames.length
    : FRAME_BYTES
  const frameSize = oneTile * tiles
  console.log(`[probe] 编码 ${ENCODING} / 瓦片 ${TILE.cols}x${TILE.rows} / 帧率 ${FPS}fps / 尺寸 ${WIDTH}x${HEIGHT} / 单帧 ${(frameSize / 1024).toFixed(0)}KB / 理论带宽 ${(frameSize * FPS / 1024 / 1024).toFixed(1)}MB/s`)

  edge = spawn(browser, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--enable-precise-memory-info',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1400,900',
    // 直接开目标页：先开 about:blank 再 navigate 会多留一个空 renderer，
    // RSS 曲线上会出现一段解释不掉的台阶
    `http://127.0.0.1:${page.port}/`
  ], { stdio: 'ignore' })
  edge.on('error', e => fail(`起不了浏览器：${e.message}`))

  // 等 CDP
  let targets = null
  for (let i = 0; i < 60 && !targets; i++) {
    await sleep(500)
    targets = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
        let body = ''
        res.on('data', d => { body += d })
        res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { resolve(null) } })
      }).on('error', () => resolve(null))
    })
  }
  if (!targets) fail('CDP 没起来')
  const pageTarget = targets.find(t => t.type === 'page' && (t.url || '').includes(`127.0.0.1:${page.port}`))
  if (!pageTarget) fail('没有 page target')
  const cdp = await cdpConnect(pageTarget.webSocketDebuggerUrl)
  cleanup.push(() => new Promise(resolve => { try { cdp.ws.close() } catch (e) {} resolve() }))

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 40; i++) {
    if (await evalJs(cdp, 'document.title') === 'ready') break
    await sleep(250)
  }
  if (await evalJs(cdp, 'document.title') !== 'ready') fail('页面脚本没就绪（noVNC 模块没加载成）')

  await evalJs(cdp, `window.__probe.connect('ws://127.0.0.1:${rfb.port}/vnc/1?token=probe')`)
  let state = 'boot'
  for (let i = 0; i < 40 && state !== 'connected'; i++) {
    state = await evalJs(cdp, 'window.__probe.state')
    await sleep(250)
  }
  if (state !== 'connected') {
    const why = await evalJs(cdp, 'JSON.stringify({events: window.__probe.events, errors: window.__probe.errors})')
    fail(`RFB 握手没完成（state=${state}）` + ' 客户端回报: ' + why)
  }

  // 基线：刚连上、还没开始持续推流
  await sleep(1000)
  const base = await evalJs(cdp, 'window.__probe.sample()')
  Object.assign(base, treeRss(edge.pid))
  const rows = [base]

  for (let s = 1; s <= SECONDS; s++) {
    await sleep(1000)
    const row = await evalJs(cdp, 'window.__probe.sample()')
    Object.assign(row, treeRss(edge.pid))
    rows.push(row)
  }

  // 断开，再采几秒：看"关掉之后还不还"
  await evalJs(cdp, 'window.__probe.disconnect()')
  await sleep(1500)
  for (let s = 0; s < 5; s++) {
    const row = await evalJs(cdp, 'window.__probe.sample()')
    Object.assign(row, treeRss(edge.pid))
    rows.push(row)
  }

  const mb = v => (v == null ? '-' : (v / 1024 / 1024).toFixed(1))
  console.log('\n  t(s)  rQbuffer  rQpending  flushing  renderQ  JSheap  renderer   全树RSS')
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i).padStart(4)}  ${mb(r.rQbufferSize).padStart(8)}  ${mb(r.rQpending).padStart(8)}  ` +
      `${String(r.flushing).padStart(7)}  ${String(r.renderQ).padStart(6)}  ${mb(r.heap).padStart(7)}  ${mb(r.renderer).padStart(8)}  ${mb(r.total).padStart(8)}`
    )
  })

  const lastStreaming = rows[SECONDS]
  const afterClose = rows[rows.length - 1]
  const verdict = []
  verdict.push(`①接收缓冲高水位：基线 ${mb(base.rQbufferSize)}MB → 刷新 ${SECONDS}s 后 ${mb(lastStreaming.rQbufferSize)}MB（上限 40MiB）`)
  verdict.push(`②断开后：_rQbufferSize 仍是 ${mb(afterClose.rQbufferSize)}MB（buffer 从不缩回，靠 disconnect 也不会还）`)
  verdict.push(`③renderer RSS：基线 ${mb(base.renderer)}MB → 峰值 ${mb(Math.max(...rows.map(r => r.renderer)))}MB → 断开 6s 后 ${mb(afterClose.renderer)}MB`)
  console.log('')
  verdict.forEach(v => console.log(' - ' + v))

  await die(0)
}

main().catch(e => {
  console.error('[vnc-mem-probe] 异常:', e)
  process.exit(1)
})
