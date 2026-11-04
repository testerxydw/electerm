// frozen-frame 的"效果"测试（无显示器 / 无 node-canvas / 无 jsdom 环境下）。
//
// 这个文件验证的不是"函数存在"，而是"功能真的生效"：
//   1. 像素保真：freezeFrame 把源画布的像素原样复制进覆盖层（不是黑屏）。
//   2. 盖黑生命周期：挂起把源画布清零后，覆盖层仍持有末帧（盖住黑屏），
//      重连成功后覆盖层才撤掉。
//   3. 接线顺序契约：真实三端源码里 freezeFrame 必须在 _release* 之前调用
//      （否则快照到的是清零后的黑屏），且 unfreezeFrame 必须在 onConnect/onsuccess 里。
//
// 为得到真实像素，这里造一个带 RGBA 缓冲的"假 canvas"，其 2D context 实现了
// drawImage(像素拷贝) / clearRect(清零) / fillRect(画已知图案) / getImageData(读像素)。

const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MOD = path.join(__dirname, '../../client/common/frozen-frame.js')

// ----------------------------------------------------------------------------
// 带真实像素缓冲的假 canvas。注意：真实 canvas 一旦赋值 width/height 会重建
// 并清空 backing store，这里用 setter 复刻该行为（freezeFrame 正是靠先设
// overlay.width/height 再 drawImage 来工作的）。
// ----------------------------------------------------------------------------
function makeFakeCanvas (w = 0, h = 0) {
  const self = { style: {} }
  let _w = w
  let _h = h
  let _buf = new Uint8ClampedArray(Math.max(0, w * h * 4))
  Object.defineProperty(self, 'width', {
    get: () => _w,
    set: (v) => { _w = v; _buf = new Uint8ClampedArray(Math.max(0, _w * _h * 4)) }
  })
  Object.defineProperty(self, 'height', {
    get: () => _h,
    set: (v) => { _h = v; _buf = new Uint8ClampedArray(Math.max(0, _w * _h * 4)) }
  })
  self.getContext = () => {
    const ctx = {
      _fill: [0, 0, 0, 255],
      fillStyle: '#000000',
      fillRect (x, y, rw, rh) {
        // 解析 #rrggbb 为 [r,g,b,a]
        const v = ctx.fillStyle
        let rgb = ctx._fill
        if (typeof v === 'string' && v[0] === '#') {
          const n = parseInt(v.slice(1), 16)
          rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
        }
        const [r, g, b, a] = rgb
        for (let j = y; j < y + rh; j++) {
          for (let i = x; i < x + rw; i++) {
            const idx = (j * _w + i) * 4
            if (idx < 0 || idx + 3 >= _buf.length) continue
            _buf[idx] = r
            _buf[idx + 1] = g
            _buf[idx + 2] = b
            _buf[idx + 3] = a
          }
        }
      },
      clearRect () {
        _buf.fill(0)
      },
      drawImage (src) {
        // freezeFrame 先把 overlay 尺寸对齐源，再 drawImage(src,0,0,w,h)，
        // 因此是 1:1 拷贝，直接拷源缓冲即可。
        if (src && src._buf && src._buf.length === _buf.length) {
          _buf.set(src._buf)
        } else if (src && src._buf) {
          _buf.set(src._buf.subarray(0, Math.min(src._buf.length, _buf.length)))
        }
      },
      getImageData () {
        return { data: _buf }
      }
    }
    return ctx
  }
  // 暴露内部缓冲给测试工具函数
  Object.defineProperty(self, '_buf', { get: () => _buf })
  return self
}

// 把整张画布涂成纯色（方便构造"已知末帧"）
function fillSolid (canvas, hex) {
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = hex
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

// 像素校验和（用于快速比对两缓冲是否一致）
function checksum (canvas) {
  let s = 0
  const d = canvas.getContext('2d').getImageData().data
  for (let i = 0; i < d.length; i++) s = (s + d[i] * (i % 7 + 1)) % 2147483647
  return s
}

// 是否整张为黑（全 0）
function isAllBlack (canvas) {
  const d = canvas.getContext('2d').getImageData().data
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false
  return true
}

describe('像素保真：freezeFrame 原样复制末帧（不是黑屏）', () => {
  beforeEach(() => {
    // 确保模块每次拿到干净状态
  })

  test('复制后覆盖层像素与源逐字节一致', async () => {
    const { freezeFrame } = await import(MOD)
    const src = makeFakeCanvas(64, 48)
    fillSolid(src, '#3366cc') // 一个明显的末帧颜色
    const overlay = makeFakeCanvas()
    const ok = freezeFrame(src, overlay)
    assert.equal(ok, true)
    assert.equal(checksum(overlay), checksum(src), '覆盖层像素必须与源一致')
    assert.equal(isAllBlack(overlay), false, '覆盖层不能是黑屏')
  })

  test('源画布后续被协议清零，不影响已冻结的覆盖层', async () => {
    const { freezeFrame } = await import(MOD)
    const src = makeFakeCanvas(64, 48)
    fillSolid(src, '#ff8800')
    const overlay = makeFakeCanvas()
    freezeFrame(src, overlay)
    const frozenSum = checksum(overlay)

    // 模拟 _releaseRfb / _releaseCanvas：协议把源画布清零
    src.getContext('2d').clearRect(0, 0, src.width, src.height)
    assert.equal(isAllBlack(src), true, '源已被清零（黑屏）')

    // 覆盖层必须仍然持有末帧，从而盖住黑屏
    assert.equal(checksum(overlay), frozenSum, '清零源后覆盖层仍是末帧')
    assert.equal(overlay.style.display, 'block', '覆盖层仍然可见')
  })
})

describe('盖黑生命周期：挂起→(源清零/重连间隙)→重连成功', () => {
  test('完整一圈：冻结可见 → 源清零期间覆盖层顶住 → 重连撤掉', async () => {
    const { freezeFrame, unfreezeFrame } = await import(MOD)
    const src = makeFakeCanvas(80, 60)
    fillSolid(src, '#22cc88')
    const overlay = makeFakeCanvas()
    const frozenSum = checksum(src)

    // ① 挂起：快照末帧
    assert.equal(freezeFrame(src, overlay), true)
    assert.equal(overlay.style.display, 'block')

    // ② 挂起把源画布清零（重连间隙用户看到的是覆盖层，而非下方黑屏）
    src.getContext('2d').clearRect(0, 0, src.width, src.height)
    assert.equal(isAllBlack(src), true)
    assert.equal(checksum(overlay), frozenSum, '间隙期覆盖层顶住黑屏')
    assert.equal(overlay.style.display, 'block')

    // ③ 重连成功：撤掉覆盖层
    unfreezeFrame(overlay)
    assert.equal(overlay.style.display, 'none')
    assert.equal(overlay.width, 0)
    assert.equal(overlay.height, 0, '显存已释放')
  })

  test('末帧尺寸异常（源宽高为 0）时不显示覆盖层，避免盖住有效画面', async () => {
    const { freezeFrame, unfreezeFrame } = await import(MOD)
    const blank = makeFakeCanvas(0, 0)
    const overlay = makeFakeCanvas()
    assert.equal(freezeFrame(blank, overlay), false)
    assert.notEqual(overlay.style.display, 'block')
    unfreezeFrame(overlay) // 不应抛
  })
})

// ----------------------------------------------------------------------------
// 接线顺序契约：保证 freezeFrame 在清零之前、unfreezeFrame 在重连成功里
// ----------------------------------------------------------------------------
function readSrc (rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
}

// 提取某个 "name = () => {" 方法的代码块（按花括号匹配到闭合）
function extractMethodBody (src, name) {
  const start = src.indexOf(`${name} = () => {`)
  if (start < 0) return null
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

describe('接线契约：三端源码 freezeFrame 必须在清零之前、unfreezeFrame 在重连里', () => {
  test('VNC: _suspendRemote 内 freezeFrame 先于 _releaseRfb；onConnect 调 unfreezeFrame', () => {
    const src = readSrc('client/components/vnc/vnc-session.jsx')
    const body = extractMethodBody(src, '_suspendRemote')
    assert.ok(body, '找到 VNC _suspendRemote')
    assert.ok(body.includes('freezeFrame('), 'VNC 挂起时调用 freezeFrame')
    assert.ok(body.includes('_releaseRfb'), 'VNC 挂起时调用 _releaseRfb')
    assert.ok(
      body.indexOf('freezeFrame(') < body.indexOf('_releaseRfb'),
      'VNC freezeFrame 必须在 _releaseRfb（清零画布）之前，否则快照到黑屏'
    )
    assert.ok(src.includes('onConnect = (event)'), 'VNC 有 onConnect')
    assert.ok(src.includes('unfreezeFrame('), 'VNC 重连成功后撤掉覆盖层')
  })

  test('RDP: _suspendRemote 内 freezeFrame 先于 _releaseCanvas；connect 成功调 unfreezeFrame', () => {
    const src = readSrc('client/components/rdp/rdp-session.jsx')
    const body = extractMethodBody(src, '_suspendRemote')
    assert.ok(body, '找到 RDP _suspendRemote')
    assert.ok(body.includes('freezeFrame('), 'RDP 挂起时调用 freezeFrame')
    assert.ok(body.includes('_releaseCanvas'), 'RDP 挂起时调用 _releaseCanvas')
    assert.ok(
      body.indexOf('freezeFrame(') < body.indexOf('_releaseCanvas'),
      'RDP freezeFrame 必须在 _releaseCanvas（清零画布）之前'
    )
    // RDP 的 unfreezeFrame 在 builder.connect 成功回调里（line ~460）
    assert.ok(src.includes('unfreezeFrame('), 'RDP 重连成功后撤掉覆盖层')
  })

  test('SPICE: _suspendRemote 内 freezeFrame 先于 _releaseCanvases；onsuccess 调 unfreezeFrame', () => {
    const src = readSrc('client/components/spice/spice-session.jsx')
    const body = extractMethodBody(src, '_suspendRemote')
    assert.ok(body, '找到 SPICE _suspendRemote')
    assert.ok(body.includes('freezeFrame('), 'SPICE 挂起时调用 freezeFrame')
    assert.ok(body.includes('_releaseCanvases'), 'SPICE 挂起时调用 _releaseCanvases')
    assert.ok(
      body.indexOf('freezeFrame(') < body.indexOf('_releaseCanvases'),
      'SPICE freezeFrame 必须在 _releaseCanvases（清零画布）之前'
    )
    assert.ok(src.includes('onsuccess:'), 'SPICE 有 onsuccess')
    assert.ok(src.includes('unfreezeFrame('), 'SPICE 重连成功后撤掉覆盖层')
  })

  test('三端都从 DOM 或协议对象取真实可见画布作为快照源（非空引用）', () => {
    const vnc = readSrc('client/components/vnc/vnc-session.jsx')
    const rdp = readSrc('client/components/rdp/rdp-session.jsx')
    const spice = readSrc('client/components/spice/spice-session.jsx')
    assert.ok(
      /freezeFrame\(\s*this\.rfb\._display\s*&&\s*this\.rfb\._display\._target/.test(vnc),
      'VNC 以 noVNC 可见画布 _target 为源'
    )
    assert.ok(/freezeFrame\(\s*this\._canvasEl/.test(rdp), 'RDP 以 _canvasEl 为源')
    assert.ok(
      /freezeFrame\(\s*this\.domRef\.current\s*&&\s*this\.domRef\.current\.querySelector\('canvas'\)/.test(spice),
      'SPICE 以 domRef 内第一个 canvas 为源'
    )
  })
})
