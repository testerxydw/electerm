/**
 * build
 */

const { exec, echo } = require('shelljs')

echo('start build')

const timeStart = +new Date()

// echo('clean')
// exec('npm run clean')
echo('version file')
echo('js/css file')
exec('npm run vite-build')
// 懒加载纪律：CM6 必须留在异步 chunk（失败即中止构建，避免首屏悄悄变胖）
echo('chunk split check')
const chunkCheck = exec('node ./src/build/bin/check-cm6-chunk.js')
if (chunkCheck.code !== 0) {
  echo('CM6 chunk split check FAILED')
  process.exit(1)
}
echo('copy file')
exec('node ./src/build/bin/copy.js')
echo('html file')
exec('node ./src/build/bin/pug.js')

const endTime = +new Date()
echo(`done build in ${(endTime - timeStart) / 1000} s`)
