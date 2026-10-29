const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// F3 §9.2 值呈现器注册表（纯逻辑，vm 加载真实源码、strip ESM export，
// 并把 detectFormats 注入为沙箱全局，避免依赖 db-value-format 的 ESM 加载链）
const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/components/database/value-renderers/index.js')

const loadMod = () => {
  const code = fs.readFileSync(SRC, 'utf8')
    .replace(/^import\s.*$/gm, '') // 去掉 import 行（检测委托给注入的 detectFormats）
    .replace(/^export\s+/gm, '') // ESM export 降级为普通声明
  const ctx = {
    detectFormats: (text) => {
      // 极简文本嗅探，足以驱动注册表的 text 分支判定
      if (typeof text !== 'string') return []
      const out = []
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) out.push({ key: 'json', label: 'JSON' })
      if (/^\s*<[a-zA-Z!?]/.test(text)) out.push({ key: 'xml', label: 'XML' })
      if (/(^|[?&])[^=&]+=[^&]*/.test(text.trim()) && !/\s/.test(text.trim())) out.push({ key: 'url', label: 'URL' })
      return out
    },
    // 故意不注入 Buffer：这是渲染进程模块，运行时里 Buffer 根本不存在。
    // 上一版把 Buffer 塞进沙箱，binPreviewBytes 用了 Buffer.from 也照样绿，
    // 真机一点二进制格就 ReferenceError 把整个数据库页签打没（CDP 实测）
    atob,
    Uint8Array,
    console
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

describe('value-renderers isBinEnvelope', () => {
  const { isBinEnvelope } = loadMod()
  test('严格匹配 __bin 信封', () => {
    assert.equal(isBinEnvelope({ __bin: { size: 5, b64: 'aGVsbG8=', truncated: false } }), true)
  })
  test('字段缺省/类型不符判 false', () => {
    assert.equal(isBinEnvelope({ __bin: { size: 5 } }), false)
    assert.equal(isBinEnvelope({ __bin: { size: '5', b64: 'x', truncated: false } }), false)
    assert.equal(isBinEnvelope({ other: 1 }), false)
    assert.equal(isBinEnvelope('x'), false)
    assert.equal(isBinEnvelope(null), false)
    assert.equal(isBinEnvelope([{ __bin: {} }]), false)
  })
})

describe('value-renderers selectRenderers（二进制）', () => {
  const { selectRenderers } = loadMod()
  test('__bin 信封进二进制分支，给出 hex/base64/image/blob-info，默认 hex，且全 readonly', () => {
    const env = { __bin: { size: 5, b64: 'aGVsbG8=', truncated: false } }
    const r = selectRenderers(env, {})
    assert.equal(r.isBinary, true)
    // vm 返回的数组属于沙箱 realm，与宿主 Array 不是同一构造函数；
    // 用 join 或 Array.from 带回宿主 realm 再比较（见项目约定）
    const keys = Array.from(r.renderers.map(x => x.key))
    assert.deepEqual(keys, ['hex', 'base64', 'image', 'blob-info'])
    assert.equal(r.defaultKey, 'hex')
    assert.ok(r.renderers.every(x => x.readonly === true), '二进制呈现器必须全 readonly')
  })

  test('column.isBinary 也能触发二进制分支（即使值不是信封）', () => {
    const r = selectRenderers('whatever', { isBinary: true })
    assert.equal(r.isBinary, true)
    assert.ok(r.renderers.length >= 4)
  })

  test('截断信封：envelope.size 透传、truncated 标记', () => {
    const env = { __bin: { size: 200000, b64: 'YWJj', truncated: true } }
    const r = selectRenderers(env, {})
    assert.equal(r.envelope.size, 200000)
    assert.equal(r.envelope.truncated, true)
  })
})

describe('value-renderers selectRenderers（文本）', () => {
  const { selectRenderers } = loadMod()
  test('纯字符串只给 raw', () => {
    const r = selectRenderers('hello world', {})
    assert.equal(r.isBinary, false)
    assert.deepEqual(Array.from(r.renderers.map(x => x.key)), ['raw'])
    assert.equal(r.defaultKey, 'raw')
  })

  test('JSON 字符串给出 raw + json，默认 json（非 raw）', () => {
    const r = selectRenderers('{"a":1}', {})
    assert.deepEqual(Array.from(r.renderers.map(x => x.key)), ['raw', 'json'])
    assert.equal(r.defaultKey, 'json')
    assert.ok(r.renderers.every(x => x.readonly === false), '文本呈现器应可编辑')
  })

  test('既非二进制也无文本嗅探 → 仅 raw 兜底', () => {
    const r = selectRenderers(123, {})
    assert.deepEqual(Array.from(r.renderers.map(x => x.key)), ['raw'])
  })
})

describe('value-renderers binPreviewBytes / bytesToHex', () => {
  const { binPreviewBytes, bytesToHex } = loadMod()
  test('小信封解码出完整字节（Uint8Array，不靠 Buffer）', () => {
    const bytes = binPreviewBytes({ size: 5, b64: btoa('hello'), truncated: false })
    assert.equal(bytes.length, 5)
    assert.equal(bytesToHex(bytes), '68656c6c6f')
  })
  test('超限信封只给前 4KB 前缀', () => {
    // 测试侧用 Node 的 Buffer 造夹具没问题；被禁的是被测模块内部引用 Buffer
    const big = Buffer.alloc(200 * 1024, 0x41).toString('base64')
    const bytes = binPreviewBytes({ size: 200 * 1024, b64: big, truncated: true })
    assert.equal(bytes.length, 4096)
  })
  test('空/非串信封给空字节串而不是抛', () => {
    assert.equal(binPreviewBytes(null).length, 0)
    assert.equal(binPreviewBytes({ size: 0, b64: 42 }).length, 0)
    assert.equal(bytesToHex(binPreviewBytes(null)), '')
  })
  test('hex 每个字节两位（0x0f 要补零，否则回读错位）', () => {
    assert.equal(bytesToHex(new Uint8Array([0, 15, 16, 255])), '000f10ff')
  })
})

describe('渲染层数据库模块不得使用 Buffer（渲染进程里没有这个全局）', () => {
  const files = [
    'src/client/components/database/value-renderers/index.js',
    'src/client/components/database/db-value-pane.jsx',
    'src/client/common/db-csv.js'
  ]
  files.forEach(f => {
    test(f + ' 不引用 Buffer', () => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      assert.ok(!/\bBuffer\b/.test(src), '改成 atob/Uint8Array：真机一点二进制格就 ReferenceError 吞掉整个页签')
    })
  })
})
