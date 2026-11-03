// AI 回复语言注入收口：一处决定"用哪种语言回复"，不再各处贴中文模板串
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../../client/common/ai-role.js')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) {
      continue
    }
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      walk(p, out)
    } else if (/\.(js|jsx|mjs)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

// 注释里允许提到旧写法（ai-role.js 的来历说明就是拿它当反面例子），只看代码
const code = src => src
  .split('\n')
  .filter(line => !/^\s*(\/\/|\/?\*)/.test(line))
  .join('\n')

describe('AI 回复语言（ai-role）', () => {
  test('语言解析：配置优先，空值退到界面语言', async () => {
    const { resolveAiLanguage } = await load()
    assert.equal(resolveAiLanguage('Deutsch', 'English'), 'Deutsch')
    assert.equal(resolveAiLanguage('', 'English'), 'English')
    assert.equal(resolveAiLanguage(undefined, 'English'), 'English')
    assert.equal(resolveAiLanguage('  Deutsch  ', 'English'), 'Deutsch')
    assert.equal(resolveAiLanguage('', ''), '')
  })

  test('指令写法只有一种，且是英文（与界面/其余提示词一致）', async () => {
    const { replyLanguageInstruction } = await load()
    assert.equal(replyLanguageInstruction('Deutsch', 'English'), 'Reply in Deutsch language')
    assert.equal(replyLanguageInstruction('', ''), '')
  })

  test('角色串：语言另起一行，不与用户的 roleAI 挤在一起', async () => {
    const { buildAiRole } = await load()
    assert.equal(
      buildAiRole({ roleAI: 'Be terse.', languageAI: 'Deutsch' }, 'English'),
      'Be terse.\nReply in Deutsch language'
    )
    // 旧写法在 roleAI 为空时产出 ';用[en]回复'（以分号开头）
    assert.equal(buildAiRole({ languageAI: 'Deutsch' }, 'English'), 'Reply in Deutsch language')
    assert.equal(buildAiRole({ roleAI: 'Be terse.' }, ''), 'Be terse.')
    assert.equal(buildAiRole({}, ''), '')
    assert.equal(buildAiRole(), '')
    // 缺失的 roleAI 不该被拼成 'undefined'
    assert.ok(!buildAiRole({ languageAI: 'Deutsch' }, 'English').includes('undefined'))
  })

  test('条目里的 languageAI 盖过界面语言，roleAI 空白被裁掉', async () => {
    const { buildAiRole } = await load()
    assert.equal(
      buildAiRole({ roleAI: '  ', languageAI: '' }, 'English'),
      'Reply in English language'
    )
    assert.equal(
      buildAiRole({ roleAI: 'X', languageAI: 'Japanese' }, 'English'),
      'X\nReply in Japanese language'
    )
  })

  test('源码契约：不再有硬编码的中文回复语言模板串', () => {
    const offenders = walk(SRC).filter(p => {
      const src = code(fs.readFileSync(p, 'utf8'))
      return /`;?\s*用\[\$\{/.test(src) || /'；?用\[' *\+/.test(src) || /;\s*用\[.{0,12}\]回复`/.test(src)
    })
    assert.deepEqual(
      offenders.map(p => path.relative(ROOT, p)),
      [],
      '回复语言必须走 common/ai-role.js'
    )
  })

  test('源码契约：AI 提示词的语言解析都走同一个函数', () => {
    const offenders = walk(SRC).filter(p => {
      const src = code(fs.readFileSync(p, 'utf8'))
      return /languageAI \|\| [\w.()]*getLangName\(\)/.test(src)
    })
    assert.deepEqual(
      offenders.map(p => path.relative(ROOT, p)),
      [],
      '必须用 resolveAiLanguage(languageAI, getLangName())'
    )
  })

  test('源码契约：这句话的写法只有 ai-role.js 一处', () => {
    // 只看产品代码：单测里断言这句话本身就该出现
    const offenders = walk(path.join(SRC, 'client')).filter(p => {
      return /Reply in \$?\{?[\w.]*\}? language/.test(code(fs.readFileSync(p, 'utf8')))
    }).map(p => path.relative(ROOT, p)).filter(p => !p.endsWith(path.join('common', 'ai-role.js')))
    assert.deepEqual(offenders, [], '要追加语言指令就调 replyLanguageInstruction()')
  })

  test('源码契约：面板的发送闭包跟着配置快照重建', () => {
    // 条目上的 roleAI/languageAI 取自发送那次渲染的 props.config，闭包不重建就带旧语言
    const src = fs.readFileSync(
      path.join(SRC, 'client/components/ai/ai-chat.jsx'), 'utf8'
    )
    const deps = /const handleSubmit = useCallback\([\s\S]*?\}, \[([\s\S]*?)\]\)/.exec(src)
    assert.ok(deps, '没找到 handleSubmit 的 useCallback')
    assert.match(deps[1], /props\.config/, '发送闭包的依赖里必须带上配置快照')
  })
})
