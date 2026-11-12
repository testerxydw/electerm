/**
 * run server in child process
 *
 */

const { fork } = require('child_process')
const { resolve } = require('path')
const { writeFileSync, unlinkSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const log = require('../common/log')
const getSystemCAs = require('../lib/system-ca')

// --use-system-ca is supported since Node.js 24.3.0
function supportsSystemCa () {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 24 || (major === 24 && minor >= 3)
}

module.exports = (config, env, sysLocale) => {
  const nodeOpts = [env.NODE_OPTIONS, supportsSystemCa() ? '--use-system-ca' : '']
    .filter(Boolean).join(' ').trim()

  // Load system-trusted CA certificates and pass to child process
  // via NODE_EXTRA_CA_CERTS so Node.js extends its trust store natively.
  let extraCaFile
  const systemCAs = getSystemCAs()
  if (systemCAs) {
    extraCaFile = join(tmpdir(), `electerm-system-ca-${Date.now()}.pem`)
    writeFileSync(extraCaFile, systemCAs)
  }

  // Clean Electron-specific env vars from child process environment
  const cleanEnv = Object.assign({}, env)
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  // set below from config, so an inherited value cannot contradict it
  delete cleanEnv.ELECTERM_DEBUG

  // start server
  const child = fork(resolve(__dirname, './server.js'), {
    env: Object.assign(
      {
        LANG: `${sysLocale.replace(/-/, '_')}.UTF-8`,
        electermPort: config.port,
        electermHost: config.host,
        requireAuth: config.requireAuth || '',
        tokenElecterm: config.tokenElecterm,
        sshKeysPath: env.sshKeysPath,
        // 子进程 fork 出去即纯 node（无 electron 模块），common/app-props 在
        // 子进程 require 必炸（2026-11-12 db-import openFile 实机事故）。
        // 数据目录必须在主进程解析好经 env 传入：widgets/paths、instance-log、
        // terminal-output-archive 的 DATA_PATH 分支都吃这个值；
        // session-server（孙进程）整链继承。用户显式 DATA_PATH 优先。
        DATA_PATH: env.DATA_PATH || (env.appPath ? resolve(env.appPath, 'electerm') : ''),
        // the child opens its log level from this at load time (../common/log.js),
        // so the ssh2 protocol trace is captured from the first session on
        ELECTERM_DEBUG: config.debug ? '1' : '',
        NODE_OPTIONS: nodeOpts || undefined,
        NODE_EXTRA_CA_CERTS: extraCaFile || undefined
      },
      cleanEnv
    ),
    cwd: process.cwd()
  }, (error, stdout, stderr) => {
    if (error || stderr) {
      throw error || stderr
    }
    log.info(stdout)
  })

  if (extraCaFile) {
    child.on('exit', () => {
      try { unlinkSync(extraCaFile) } catch {}
    })
  }

  return child
}
