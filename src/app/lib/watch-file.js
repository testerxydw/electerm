const fs = require('original-fs')
const globalState = require('./glob-state')
const _ = require('./lodash.js')

// 上次广播过的内容：外部编辑器常常「保存但没改」（打开/关闭即触发 stat 变化），
// 内容一致就不再走 IPC，避免消费方整页重渲染
let lastText = null
// 异步读期间又收到事件时合并到下一轮，避免并发读同一文件
let reading = false
let pending = false

const onWatch = _.debounce(async () => {
  if (reading) {
    pending = true
    return
  }
  reading = true
  try {
    const filePath = globalState.get('watchFilePath')
    if (!filePath) {
      return
    }
    if (fs.existsSync(filePath)) {
      // 异步读：watch 回调跑在主进程，readFileSync 会阻塞事件循环
      const text = await fs.promises.readFile(filePath, 'utf8')
      // 读期间可能已切换到别的被监听文件，旧内容不能再广播
      if (globalState.get('watchFilePath') !== filePath) {
        return
      }
      if (text !== lastText) {
        lastText = text
        globalState.get('win').webContents.send('file-change', text)
      }
    } else {
      console.log('Watched file no longer exists')
      lastText = null
      globalState.get('win').webContents.send('file-deleted')
    }
  } catch (e) {
    console.error('Error reading file:', e)
    globalState.get('win').webContents.send('file-read-error', e.message)
  } finally {
    reading = false
    if (pending) {
      pending = false
      onWatch()
    }
  }
}, 300, { leading: false, trailing: true })

exports.watchFile = (path) => {
  const prev = globalState.get('watchFilePath')
  if (prev && prev !== path) {
    fs.unwatchFile(prev, onWatch)
  }
  if (prev !== path) {
    // 换文件后即使内容相同也要通知一次
    lastText = null
  }
  globalState.set('watchFilePath', path)
  fs.watchFile(path, onWatch)
}

exports.unwatchFile = (path) => {
  globalState.set('watchFilePath', '')
  lastText = null
  fs.unwatchFile(path, onWatch)
}

exports.cleanWatchFile = () => {
  const filePath = globalState.get('watchFilePath')
  globalState.set('watchFilePath', '')
  lastText = null
  if (!filePath) {
    return
  }
  fs.unwatchFile(filePath, onWatch)
}

process.on('exit', exports.cleanWatchFile)
