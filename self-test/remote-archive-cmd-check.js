// 用本机真 tar/zip 跑一遍生成的命令串：判据不是"字符串长得对"，是"远端真能跑"
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { planArchiveCreate, planArchiveList, planArchiveExtract, parseArchiveListing } = require('../src/app/common/remote-archive')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-g4-cmd-'))
const src = path.join(root, 'srv data')
fs.mkdirSync(src, { recursive: true })
const names = ['-weird.tar', '含 中文.txt', 'a b.txt', '$(whoami).log', "q'uote\"d"]
for (const n of names) {
  fs.writeFileSync(path.join(src, n), 'payload-' + n)
}
const sources = names.map(n => path.join(src, n))

let pass = 0
let fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ' + label) } else { fail++; console.log('  FAIL ' + label + ' ' + extra) }
}
const sh = (cmd, cwd) => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', cwd })

// 1. tar.gz 打包
const tgzDest = path.join(root, '打包 out.tar.gz')
const t1 = planArchiveCreate({ kind: 'tar.gz', sources, dest: tgzDest })
sh(t1.cmd)
ok('tar.gz 产出文件存在', fs.existsSync(tgzDest))
const l1 = planArchiveList({ archivePath: tgzDest })
sh(l1.cmd)
const listed = parseArchiveListing(sh(l1.cmd))
ok('tar 清单条数 = ' + names.length, listed.total === names.length, JSON.stringify(listed))
ok('tar 清单含 -weird.tar', listed.entries.includes('-weird.tar'), JSON.stringify(listed.entries))
ok('tar 清单无绝对路径前缀', listed.entries.every(e => !e.startsWith('/')))

// 2. tar.gz 解压到另一个目录
const outDir = path.join(root, 'out dir')
fs.mkdirSync(outDir, { recursive: true })
sh(planArchiveExtract({ archivePath: tgzDest, destDir: outDir }).cmd)
const got = fs.readdirSync(outDir).sort()
ok('解压后文件名逐个一致', JSON.stringify(got) === JSON.stringify([...names].sort()), JSON.stringify(got))
ok('解压内容正确', fs.readFileSync(path.join(outDir, '-weird.tar'), 'utf8') === 'payload--weird.tar')

// 3. zip 打包（本机有 zip，走 then 支）。名字别和上面 tar.gz 的产出撞上，
//    否则"回退名未生成"这条判据是在跟自己比
const zipDest = path.join(root, '压缩包.zip')
const t3 = planArchiveCreate({ kind: 'zip', sources, dest: zipDest })
const o3 = sh(t3.cmd)
ok('zip 分支未误报降级', o3.indexOf('ELECTERM_ARCHIVE_NO_ZIP') < 0, JSON.stringify(o3))
ok('zip 产出文件存在', fs.existsSync(zipDest))
ok('tar.gz 回退名未生成', !fs.existsSync(zipDest.replace(/\.zip$/, '.tar.gz')))
const l3 = planArchiveList({ archivePath: zipDest })
const listed3 = parseArchiveListing(sh(l3.cmd))
ok('zip 清单条数 = ' + names.length, listed3.total === names.length, JSON.stringify(listed3))
ok('zip 清单里 -weird.tar 不带 ./ 前缀', listed3.entries.includes('-weird.tar'), JSON.stringify(listed3.entries))

// 4. zip 解压
const zipOut = path.join(root, 'zip out')
fs.mkdirSync(zipOut, { recursive: true })
sh(planArchiveExtract({ archivePath: zipDest, destDir: zipOut }).cmd)
ok('zip 解压后文件名逐个一致', JSON.stringify(fs.readdirSync(zipOut).sort()) === JSON.stringify([...names].sort()))

// 5. 假装远端没有 zip：PATH 只指向一个"有 tar/gzip、没有 zip"的目录，验证降级支
const fake = path.join(root, 'fakebin')
fs.mkdirSync(fake, { recursive: true })
// tar -z 会自己 execvp 一个 gzip，两个都要链过去，否则测的是 PATH 不全不是没有 zip
for (const bin of ['tar', 'gzip', 'sh']) {
  const p = execFileSync('/bin/sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).trim()
  if (p) {
    fs.symlinkSync(p, path.join(fake, bin))
  }
}
// 注意：`PATH=x if ...` 不是合法 shell（赋值前缀不能配复合命令），只能走 env
const o5 = execFileSync('/bin/sh', ['-c', t3.cmd], {
  encoding: 'utf8',
  env: { PATH: fake }
})
ok('无 zip 时打出降级标记', o5.includes('ELECTERM_ARCHIVE_NO_ZIP'), JSON.stringify(o5))
ok('无 zip 时降级文件真产出', fs.existsSync(t3.fallback.producedPath))
ok('降级产出的确是 tar.gz', parseArchiveListing(sh(planArchiveList({ archivePath: t3.fallback.producedPath }).cmd)).total === names.length)

// 6. 恶意文件名不会逃出引号：载荷里不带 /（带 / 就成嵌套目录，压根建不出这个文件），
//    改用相对路径 + 把执行目录定在 evil 里，看有没有真的执行
const evil = path.join(root, 'evil')
fs.mkdirSync(evil, { recursive: true })
const evilName = 'x"; touch PWNED; echo "'
fs.writeFileSync(path.join(evil, evilName), 'x')
const t6 = planArchiveCreate({
  kind: 'tar.gz',
  sources: [path.join(evil, evilName)],
  dest: path.join(evil, 'e.tar.gz')
})
sh(t6.cmd, evil)
ok('注入载荷没有被执行（evil 目录里没多出 PWNED）', !fs.existsSync(path.join(evil, 'PWNED')), t6.cmd)
const l6 = parseArchiveListing(sh(planArchiveList({ archivePath: path.join(evil, 'e.tar.gz') }).cmd))
ok('注入载荷原样进清单（当成文件名）', l6.entries.length === 1 && l6.entries[0] === evilName, JSON.stringify(l6))
const evilOut = path.join(root, 'evil out')
fs.mkdirSync(evilOut, { recursive: true })
sh(planArchiveExtract({ archivePath: path.join(evil, 'e.tar.gz'), destDir: evilOut }).cmd, evil)
ok('注入名解压后仍是那个名字', fs.existsSync(path.join(evilOut, evilName)))
ok('解压也没执行注入载荷', !fs.existsSync(path.join(evilOut, 'PWNED')))

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
