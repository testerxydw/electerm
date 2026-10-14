const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../../client/components/database/db-value-format.js')

const PY = "{'name': 'flatnum', 'tiers': [{'disk_type': 'nvme', 'size': 35874000}], 'safe': True, 'cache': None, 'ratio': 0.25}"

describe('redis value format', () => {
  test('JSON values are pretty printed', async () => {
    const { detectFormats, formatValue } = await load()
    const raw = '{"a":1,"b":[1,2],"c":{"d":null}}'
    assert.deepEqual(detectFormats(raw).map(f => f.key), ['json'])
    assert.equal(
      formatValue(raw, 'json'),
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {\n    "d": null\n  }\n}'
    )
  })

  test('python dict repr (single quotes, True/False/None) is prettified', async () => {
    const { detectFormats, formatValue } = await load()
    const keys = detectFormats(PY).map(f => f.key)
    assert.ok(keys.includes('python'), keys.join(','))
    const out = formatValue(PY, 'python')
    assert.equal(
      out,
      [
        '{',
        '  "name": "flatnum",',
        '  "tiers": [',
        '    {',
        '      "disk_type": "nvme",',
        '      "size": 35874000',
        '    }',
        '  ],',
        '  "safe": true,',
        '  "cache": null,',
        '  "ratio": 0.25',
        '}'
      ].join('\n')
    )
  })

  test('python bytes prefix and tuples are handled', async () => {
    const { parsePythonValue } = await load()
    assert.deepEqual(parsePythonValue("(b'x', u'y', 1,)"), ['x', 'y', 1])
  })

  test('python expressions are refused instead of guessed', async () => {
    const { detectFormats } = await load()
    const keys = detectFormats('datetime.datetime(2026, 1, 1, tzinfo=utc)').map(f => f.key)
    assert.equal(keys.includes('python'), false)
  })

  test('xml is indented', async () => {
    const { detectFormats, formatValue } = await load()
    const raw = '<?xml version="1.0"?><root><a>1</a><b/></root>'
    assert.deepEqual(detectFormats(raw).map(f => f.key), ['xml'])
    assert.equal(
      formatValue(raw, 'xml'),
      ['<?xml version="1.0"?>', '<root>', '  <a>1</a>', '  <b/>', '</root>'].join('\n')
    )
  })

  test('query strings become one parameter per line, percent decoded', async () => {
    const { detectFormats, formatValue } = await load()
    const raw = 'https://h/p?a=1&b=x%20y&flag'
    assert.deepEqual(detectFormats(raw).map(f => f.key), ['url'])
    assert.equal(
      formatValue(raw, 'url'),
      ['https://h/p?', 'a = 1', 'b = x y', 'flag'].join('\n')
    )
  })

  test('plain text offers no format and falls back to the raw value', async () => {
    const { detectFormats, formatValue } = await load()
    assert.deepEqual(detectFormats('hello world'), [])
    assert.equal(formatValue('hello world', 'json'), 'hello world')
    assert.equal(formatValue('hello world', 'raw'), 'hello world')
  })

  test('huge values are left alone', async () => {
    const { detectFormats, formatValue } = await load()
    const huge = '{"a":"' + 'x'.repeat(600 * 1024) + '"}'
    assert.deepEqual(detectFormats(huge), [])
    assert.equal(formatValue(huge, 'json'), huge)
  })
})
