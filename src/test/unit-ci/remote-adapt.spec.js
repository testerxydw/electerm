// 批次 A/B · 远程会话窗口自适应的决策层契约
//
// 背景（分析-RDP-VNC窗口自适应与资源开销 §3、§5）：RDP 位图内存 ∝ 宽×高，
// "跟随窗口"必须有上限；noVNC 的 setter 不判等、写 canvas.width 会重分配
// backing store 并整屏 blit，所以 resize 链路必须合并 + 判等。这些判断抽成
// src/client/common/remote-adapt.js 的纯函数后，就不需要真机也能断言。
//
// 尾段是源码字符串契约：纯函数对了但组件没接线，等于没做。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const loadMod = () => import('../../client/common/remote-adapt.js')

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('remote-adapt 尺寸决策', () => {
  test('上限就是拍定的 1920x1080（D1），抖动窗口 200ms、阈值 2px', async () => {
    const { MAX_DESKTOP, MIN_DESKTOP, RESIZE_MERGE_MS, VIEWPORT_EPSILON } = await loadMod()
    assert.deepEqual(MAX_DESKTOP, { width: 1920, height: 1080 })
    assert.deepEqual(MIN_DESKTOP, { width: 800, height: 600 })
    assert.equal(RESIZE_MERGE_MS, 200)
    assert.equal(VIEWPORT_EPSILON, 2)
  })

  test('字符串宽高不是数值尺寸：res-auto 永远不能流进 DesktopSize', async () => {
    const { isNumericSize, isAutoRes } = await loadMod()
    const resolutions = [
      { id: 'res-auto', width: 'auto', height: 'auto' },
      { id: 'res-1', width: 1024, height: 768 }
    ]
    assert.equal(isNumericSize(resolutions[0]), false)
    assert.equal(isAutoRes(resolutions[0]), true)
    assert.equal(isNumericSize(resolutions[1]), true)
    assert.equal(isAutoRes(resolutions[1]), false)
    // 脏值：NaN / 0 / 负数 / undefined / 字符串数字
    assert.equal(isNumericSize({ width: NaN, height: 600 }), false)
    assert.equal(isNumericSize({ width: 0, height: 600 }), false)
    assert.equal(isNumericSize({ width: -1, height: 600 }), false)
    assert.equal(isNumericSize(undefined), false)
    assert.equal(isNumericSize({ width: '1920', height: '1080' }), true)
  })

  test('自动尺寸夹到 [800x600, 1920x1080] 并取整', async () => {
    const { clampDesktopSize } = await loadMod()
    assert.deepEqual(clampDesktopSize({ width: 200, height: 200 }), { width: 800, height: 600 })
    assert.deepEqual(clampDesktopSize({ width: 4096, height: 2160 }), { width: 1920, height: 1080 })
    assert.deepEqual(clampDesktopSize({ width: 1300.6, height: 799.4 }), { width: 1301, height: 799 })
  })

  test('手选尺寸只保底不封顶：点了 4K 不该被改成 1920x1080', async () => {
    const { clampManualSize, MAX_MANUAL_DESKTOP } = await loadMod()
    assert.deepEqual(clampManualSize({ width: 3840, height: 2160 }), { width: 3840, height: 2160 })
    assert.deepEqual(clampManualSize({ width: 100, height: 100 }), { width: 800, height: 600 })
    // 荒谬值仍然挡掉，避免把脏数据交给 wasm
    assert.deepEqual(clampManualSize({ width: 99999, height: 99999 }), MAX_MANUAL_DESKTOP)
  })

  test('首连尺寸优先级：手选 > 实测视口 > 占位', async () => {
    const { resolveInitialSize } = await loadMod()
    assert.deepEqual(
      resolveInitialSize({
        measured: { width: 1400, height: 900 },
        manual: { width: 1600, height: 1200 }
      }),
      { width: 1600, height: 1200, source: 'manual' }
    )
    assert.deepEqual(
      resolveInitialSize({ measured: { width: 1400, height: 900 }, manual: null }),
      { width: 1400, height: 900, source: 'viewport' }
    )
    // 超上限的视口夹到 cap，超出部分交 CSS 缩放
    assert.deepEqual(
      resolveInitialSize({ measured: { width: 3000, height: 1600 }, manual: null }),
      { width: 1920, height: 1080, source: 'viewport' }
    )
    // 隐藏 tab 量到 0x0：走占位值，绝不能把 0 交给 wasm
    assert.deepEqual(
      resolveInitialSize({ measured: { width: 0, height: 0 }, manual: null }),
      { width: 1024, height: 768, source: 'fallback' }
    )
    assert.deepEqual(
      resolveInitialSize({}),
      { width: 1024, height: 768, source: 'fallback' }
    )
    // res-auto 存下来的 'auto' 字符串不会被当成 manual
    assert.deepEqual(
      resolveInitialSize({ measured: { width: 1280, height: 800 }, manual: { width: 'auto', height: 'auto' } }),
      { width: 1280, height: 800, source: 'viewport' }
    )
  })

  test('视口抖动：<=2px 不重排，首次测量总是有效', async () => {
    const { shouldReLayout } = await loadMod()
    assert.equal(shouldReLayout(null, { width: 1000, height: 700 }), true)
    assert.equal(shouldReLayout({ width: 1000, height: 700 }, { width: 1001, height: 701 }), false)
    assert.equal(shouldReLayout({ width: 1000, height: 700 }, { width: 1003, height: 700 }), true)
    assert.equal(shouldReLayout({ width: 1000, height: 700 }, { width: 1000, height: 703 }), true)
    // 变成无效尺寸不触发重排（隐藏窗格 / 卸载中的 0x0）
    assert.equal(shouldReLayout({ width: 1000, height: 700 }, { width: 0, height: 0 }), false)
  })

  test('拖窗手势：合并窗把每帧一次重排压成每手势一次', async () => {
    const { shouldReLayout, RESIZE_MERGE_MS } = await loadMod()
    // 复刻组件侧那两行（vnc-session 的 handleViewportResize）：
    //   抖动过滤 + 单一可重置定时器；帧间隔小于合并窗时就只重置、不执行
    const simulate = (events) => {
      let lastLayout = null
      let dueAt = null
      let layouts = 0
      for (const { at, frame } of events) {
        // 两次回调之间若已过合并窗，排程先执行
        if (dueAt !== null && at >= dueAt) {
          layouts += 1
          dueAt = null
        }
        if (!shouldReLayout(lastLayout, frame)) {
          continue
        }
        lastLayout = frame
        dueAt = at + RESIZE_MERGE_MS
      }
      // 停手后最终一次
      if (dueAt !== null) {
        layouts += 1
      }
      return layouts
    }
    const drag = (from, to, steps, startMs, stepMs) => Array.from(
      { length: steps + 1 },
      (_, i) => ({
        at: startMs + i * stepMs,
        frame: {
          width: Math.round(from.width + (to.width - from.width) * i / steps),
          height: Math.round(from.height + (to.height - from.height) * i / steps)
        }
      })
    )
    // 60fps 拖窗（16ms/帧、34 帧）：旧实现每帧一次 = 34 次，现在只认停手后的最终尺寸
    const gesture = drag(
      { width: 1440, height: 900 },
      { width: 1100, height: 700 },
      33, 0, 16
    )
    assert.equal(simulate(gesture), 1)
    // 手势刚结束时的 1px 抖动（滚动条/DPR 取整）不该多触发一次
    assert.equal(
      simulate(gesture.concat([{ at: 600, frame: { width: 1100, height: 701 } }])),
      1
    )
    // 两次拖窗隔开 400ms（> 合并窗）→ 各自重排一次
    assert.equal(
      simulate(gesture.concat(drag(
        { width: 1100, height: 700 },
        { width: 1300, height: 800 },
        5, 1000, 16
      ))),
      2
    )
    // 合并窗必须明显大于一帧间隔，否则拖窗过程中根本合不住
    assert.ok(RESIZE_MERGE_MS > 100, '合并窗小于 100ms 就合不住拖窗手势')
  })

  test('缩放开关取值：本机记忆 > 书签字段 > 默认开', async () => {
    const { resolveScaleViewport } = await loadMod()
    // 本机从没设过（null）→ 书签字段说了算，旧书签缺字段 = 开
    assert.equal(resolveScaleViewport(null, undefined), true)
    assert.equal(resolveScaleViewport(null, true), true)
    assert.equal(resolveScaleViewport(null, false), false)
    // 显式关过的 host 保持关，显式开过的保持开（D2：不做无差别翻转）
    assert.equal(resolveScaleViewport(false, true), false)
    assert.equal(resolveScaleViewport(true, false), true)
  })
})

describe('remote-adapt 组件接线契约', () => {
  test('RDP：接 onViewportResize、首连尺寸走 resolveConnectSize、不再 reloadTab 重连', () => {
    const src = read('src/client/components/rdp/rdp-session.jsx')
    assert.match(src, /onViewportResize=\{this\.handleViewportResize\}/)
    assert.match(src, /const \{ width, height \} = this\.resolveConnectSize\(\)/)
    assert.match(src, /new window\.ironRdp\.DesktopSize\(width, height\)/)
    // R4：改分辨率/重连都走原地 cleanup + remoteInit
    assert.match(src, /handleReInit = \(\) => \{[\s\S]{0,200}this\.cleanup\(\)[\s\S]{0,120}this\.remoteInit\(\)/)
    // R1：三态读取，未设置才翻默认
    assert.match(src, /ls\.getItemJSON\(scaleViewportId, null\)/)
    // 子先于父挂载，连接必须延到视口量到之后
    assert.match(src, /componentDidMount \(\)[\s\S]{0,300}Promise\.resolve\(\)\.then/)
    // 旧的 -10 / -80 魔数兜底不许回到 RDP
    assert.doesNotMatch(src, /width - 10|height - 80/)
  })

  test('R5b：res-auto 进下拉且字符串宽高不进 DesktopSize', () => {
    const src = read('src/client/components/rdp/rdp-session.jsx')
    assert.match(src, /const auto = resolutions\.filter\(isAutoRes\)/)
    assert.match(src, /window\.translate\('resolutionAuto'\)/)
    assert.doesNotMatch(src, /resolutions\.slice\(1\)/)
  })

  test('VNC：回调节流 + setter 判等 + 不再读 container.clientWidth', () => {
    const src = read('src/client/components/vnc/vnc-session.jsx')
    assert.match(src, /setTimeout\(this\.updateViewLayout, RESIZE_MERGE_MS\)/)
    assert.match(src, /shouldReLayout\(this\.lastLayoutSize, next\)/)
    assert.match(src, /if \(this\.appliedFit !== fit\)/)
    assert.match(src, /if \(this\.appliedClip !== clipViewport\)/)
    assert.doesNotMatch(src, /autoscale\(container\.clientWidth, container\.clientHeight\)/)
    assert.match(src, /clearTimeout\(this\.layoutTimer\)/)
  })

  test('SPICE：与 RDP 同一默认值口径', () => {
    const src = read('src/client/components/spice/spice-session.jsx')
    assert.match(src, /ls\.getItemJSON\(scaleViewportId, null\)/)
    assert.match(src, /resolveScaleViewport\(/)
  })

  test('C1：vnc 路由按 (width, height) 传参，不再把整个 query 当宽', () => {
    const src = read('src/app/server/session-server.js')
    assert.doesNotMatch(src, /term\.start\(query\)/)
    assert.match(src, /term\.start\(width, height\)/)
  })
})
