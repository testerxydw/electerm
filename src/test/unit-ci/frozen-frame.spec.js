const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// frozen-frame.js 是纯 ESM 模块，零依赖。jsdom 不实现 canvas 渲染，
// 这里用假的 canvas 对象验证"快照 / 撤掉"的状态机逻辑。
const MOD = require('node:path').join(
  __dirname, '../../client/common/frozen-frame.js'
)

// 造一个假 canvas：带可写的 width/height、可控的 getContext。
function fakeCanvas (w = 0, h = 0) {
  return {
    width: w,
    height: h,
    style: {},
    getContext: () => ({
      clearRect () {},
      drawImage () {}
    })
  }
}

describe('freezeFrame：挂起瞬间快照末帧到覆盖层', () => {
  test('成功快照：覆盖层尺寸对齐源、display=block、返回 true', async () => {
    const { freezeFrame } = await import(MOD)
    const overlay = fakeCanvas()
    const ok = freezeFrame(fakeCanvas(800, 600), overlay)
    assert.equal(ok, true)
    assert.equal(overlay.width, 800)
    assert.equal(overlay.height, 600)
    assert.equal(overlay.style.display, 'block')
  })

  test('源尺寸为 0 / 异常时不显示覆盖层（避免盖住有效画面）', async () => {
    const { freezeFrame } = await import(MOD)
    const overlay = fakeCanvas()
    assert.equal(freezeFrame(fakeCanvas(0, 0), overlay), false)
    assert.equal(freezeFrame(null, overlay), false)
    assert.equal(freezeFrame(fakeCanvas(100, 100), null), false)
    assert.equal(overlay.style.display, undefined, '未成功时不应显示覆盖层')
  })

  test('getContext 返回 null（如无 canvas 环境）时安全返回 false', async () => {
    const { freezeFrame } = await import(MOD)
    const overlay = { width: 0, height: 0, style: {}, getContext: () => null }
    assert.equal(freezeFrame(fakeCanvas(100, 100), overlay), false)
  })
})

describe('unfreezeFrame：重连成功后撤掉覆盖层', () => {
  test('隐藏并把尺寸归零，释放显存', async () => {
    const { unfreezeFrame } = await import(MOD)
    const overlay = fakeCanvas(800, 600)
    overlay.style.display = 'block'
    unfreezeFrame(overlay)
    assert.equal(overlay.style.display, 'none')
    assert.equal(overlay.width, 0)
    assert.equal(overlay.height, 0)
  })

  test('overlay 为 null 时不抛（防御性）', async () => {
    const { unfreezeFrame } = await import(MOD)
    assert.doesNotThrow(() => unfreezeFrame(null))
  })
})
