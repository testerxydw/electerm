#!/usr/bin/env node
/**
 * 口径 S：全项目默认值 / 固定值盘点（只读、不落盘、不进 unit-ci 主流程）。
 *
 * 口径定义见 doc/已完成/分析-全项目默认值与固定值SSOT化可优化点-2026-11-14.md §1.2：
 *   - 文件集：src/app/** 与 src/client/** 下所有 .js/.jsx，排除 *.spec.js / *.test.js
 *   - 定义行：行首 const / export const / exports.NAME，名字全大写且值以字面量开头
 *   - 上限类：名字命中 MAX|LIMIT|DEFAULT|THRESHOLD|TIMEOUT|CAP|MIN|INTERVAL|BUDGET
 *
 * 用途：同口径前后对比、热点集合排序、P1 清单输入。**绝对值不作验收判据**，
 * 重跑允许随基线小幅浮动；真正被契约锁锁住的是「统计结果可复算」「热点集合稳定」
 * 与「同名不同值集合与白名单登记相等」（见 defaults-inventory / defaults-naming 两 spec）。
 *
 * 用法：
 *   node src/build/bin/inventory-defaults.js           # 人读输出
 *   node src/build/bin/inventory-defaults.js --json   # 机器读（供契约 spec 校验）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const DEF_RE = /^[ \t]*(?:(?:export[ \t]+)?const|(?:module\.)?exports\.)[ \t]*([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*(?:-?\d|["'[{]|true\b|false\b|null\b|Object\.freeze\b)/
const UPPER_RE = /MAX|LIMIT|DEFAULT|THRESHOLD|TIMEOUT|CAP|MIN|INTERVAL|BUDGET/

/** 递归收集产品源码文件；测试 / 构建 / 产物目录天然不在 src/app 与 src/client 下。 */
function sourceFiles () {
  const files = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|jsx)$/.test(full) && !/\.(spec|test)\.js$/.test(full)) files.push(full)
    }
  }
  ;['src/app', 'src/client'].forEach(dir => walk(path.join(ROOT, dir)))
  return files
}

/**
 * 单次盘点。同名不同值只统计「右侧为字面量」的定义行（口径 S 已保证），
 * 因此 const X = require(...) / const X = otherAlias 这类引用与 re-export 别名
 * 不会被误判为第二份定义（§2.4 口径局限）。
 */
function collect () {
  const hitFiles = new Set()
  const byDir = {}
  const definitions = new Map()
  let total = 0
  let upperClass = 0

  for (const file of sourceFiles()) {
    const rel = path.relative(ROOT, file)
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(DEF_RE)
      if (!match) continue
      total++
      hitFiles.add(rel)
      if (UPPER_RE.test(match[1])) upperClass++
      const key = rel.split(path.sep).slice(0, 3).join('/')
      byDir[key] = (byDir[key] || 0) + 1

      const code = line.replace(/\/\/.*$/, '').trim().replace(/,[ \t]*$/, '')
      const rhs = code.slice(code.indexOf('=') + 1).trim()
      if (!definitions.has(match[1])) definitions.set(match[1], new Set())
      definitions.get(match[1]).add(rhs)
    }
  }

  const conflicts = [...definitions.entries()]
    .filter(([, variants]) => variants.size > 1)
    .map(([name, variants]) => ({ name, variants: [...variants].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    total,
    files: hitFiles.size,
    upperClass,
    byDir,
    conflicts,
    conflictNames: conflicts.map(item => item.name)
  }
}

function main () {
  // 允许 `... | head` 这类管道提前关闭，不把 EPIPE 报成脚本失败。
  process.stdout.on('error', err => {
    if (err.code === 'EPIPE') process.exit(0)
    throw err
  })
  const data = collect()
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(data) + '\n')
    return
  }
  process.stdout.write(`TOTAL ${data.total} FILES ${data.files} UPPER_CLASS ${data.upperClass}\n`)
  process.stdout.write('--- BY DIR ---\n')
  Object.entries(data.byDir)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .forEach(([key, count]) => process.stdout.write(`${count} ${key}\n`))
  process.stdout.write('--- NAME CONFLICTS (name | variant count) ---\n')
  data.conflicts.forEach(item => {
    process.stdout.write(`${item.name} | ${item.variants.length}\n`)
  })
}

main()
