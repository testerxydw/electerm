/**
 * #4464 代理地址归一（上游 issue 分析）
 *
 * 只验口径：
 *   - 裸 `host:port` 补成 http://（以前静默丢弃 → 请求直连且无提示）；
 *   - 带 scheme 的原样通过，含 socks5 家族；
 *   - 空值仍返回 undefined（不建 agent，走直连）；
 *   - 非 http/socks 的协议与含空格的畸形值报错，而不是静默直连。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { SocksProxyAgent } = require('socks-proxy-agent')

const { normalizeProxyUrl, createProxyAgent } = require('../../app/lib/proxy-agent')

describe('代理地址归一', () => {
  it('裸 host:port 补 http://', () => {
    assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
    assert.equal(normalizeProxyUrl(' proxy.example.com:3128 '), 'http://proxy.example.com:3128')
    assert.equal(normalizeProxyUrl('user:pass@10.0.0.1:8080'), 'http://user:pass@10.0.0.1:8080')
  })

  it('带协议的原样通过', () => {
    assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
    assert.equal(normalizeProxyUrl('https://a.b:1'), 'https://a.b:1')
  })

  it('空值返回 undefined', () => {
    assert.equal(normalizeProxyUrl(''), undefined)
    assert.equal(normalizeProxyUrl(undefined), undefined)
    assert.equal(normalizeProxyUrl('   '), undefined)
    assert.equal(normalizeProxyUrl(123), undefined)
  })

  it('不支持的协议与畸形值报错', () => {
    assert.throws(() => normalizeProxyUrl('ftp://a.b:21'), /Unsupported proxy protocol "ftp"/)
    assert.throws(() => normalizeProxyUrl('a b:1'), /Invalid proxy/)
    assert.throws(() => normalizeProxyUrl('a.b:1 /path'), /Invalid proxy/)
  })
})

describe('代理 agent 构造', () => {
  it('裸地址也能拿到 http agent', () => {
    const agent = createProxyAgent('127.0.0.1:7890')
    assert.ok(agent instanceof HttpsProxyAgent)
    assert.equal(agent.proxy.port, '7890')
    assert.equal(agent.proxy.hostname, '127.0.0.1')
  })

  it('socks 前缀走 socks agent', () => {
    const agent = createProxyAgent('socks5://127.0.0.1:1080')
    assert.ok(agent instanceof SocksProxyAgent)
    assert.deepEqual(agent.proxy, { host: '127.0.0.1', port: 1080, type: 5 })
  })

  it('空值不建 agent', () => {
    assert.equal(createProxyAgent(''), undefined)
    assert.equal(createProxyAgent(undefined), undefined)
  })
})
