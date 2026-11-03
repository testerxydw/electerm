// #4216 最小化恢复后终端留白：可见性/焦点通道必须接上 fit+refresh 那条既有链
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const TERMINAL = path.join(ROOT, 'src/client/components/terminal/terminal.jsx')

const load = p => fs.readFileSync(p, 'utf8')

describe('#4216 恢复可见后强制重绘', () => {
  test('挂载注册 visibilitychange + focus，卸载必须成对摘掉', () => {
    const src = load(TERMINAL)
    const did = src.match(/componentDidMount \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(did, 'componentDidMount 存在')
    assert.ok(did[0].includes("document.addEventListener('visibilitychange', this.onWindowBack)"), '可见性监听')
    assert.ok(did[0].includes("window.addEventListener('focus', this.onWindowBack)"), '焦点监听')
    const will = src.match(/componentWillUnmount \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(will, 'componentWillUnmount 存在')
    assert.ok(will[0].includes("document.removeEventListener('visibilitychange', this.onWindowBack)"), '摘可见性监听')
    assert.ok(will[0].includes("window.removeEventListener('focus', this.onWindowBack)"), '摘焦点监听')
  })

  test('处理函数只在真正回到前台时重绘，且走 fitAndRefresh（反向：绕过守卫直接 fit）', () => {
    const src = load(TERMINAL)
    const m = src.match(/onWindowBack = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(m, 'onWindowBack 存在')
    assert.match(m[0], /document\.visibilityState !== 'visible'/, '隐藏态不处理')
    assert.ok(m[0].includes('this.onClose'), '卸载后不再重绘')
    assert.ok(m[0].includes('requestAnimationFrame'), '等恢复后的布局帧')
    assert.ok(m[0].includes('this.fitAndRefresh()'), '走带可见性守卫的 fitAndRefresh')
    assert.ok(!src.includes('this.fitAddon.fit()'), 'terminal.jsx 不得绕过守卫直接 fit')
  })
})
