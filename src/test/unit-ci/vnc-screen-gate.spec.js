// 批次 E：VNC checkScreens 内容 gate 与定时器清理
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/vnc/vnc-session.jsx')
const src = fs.readFileSync(JSX, 'utf8')

describe('批次 E：VNC 屏幕列表 gate', () => {
  test('screens 内容没变不 setState', () => {
    const block = src.match(/checkScreens = \(\) => \{[\s\S]*?\n\s{2}\}/)
    assert.ok(block, 'checkScreens not found')
    assert.ok(block[0].includes('cur.length === next.length'), 'length compare missing')
    assert.ok(block[0].includes('next.every((s, i) => s.id === cur[i].id)'), 'id compare missing')
    assert.ok(block[0].includes('if (!same)'), 'setState gate missing')
  })

  test('capabilities 定时器可取消且卸载时清理', () => {
    assert.ok(src.includes('clearTimeout(this.screenTimer)'), 'screen timer not cleared before reschedule')
    assert.ok(src.includes('this.screenTimer = setTimeout(this.checkScreens, 1000)'), 'screen timer not stored')
    const unmount = src.match(/componentWillUnmount \(\) \{[\s\S]*?\n\s{2}\}/)
    assert.ok(unmount, 'componentWillUnmount not found')
    assert.ok(unmount[0].includes('clearTimeout(this.screenTimer)'), 'screen timer not cleared on unmount')
  })
})
