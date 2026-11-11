/**
 * transferKeys 常量独立成零依赖小模块（资源优化 P2）：
 * `server/transfer.js` 顶层拉起 `ssh2-scp/folder-transfer` + `tar` + `original-fs`
 * 全图，而 dispatch-center / ipc-sync 只需要这三个方法名的白名单。此前它们
 * 为了一个常量把 ssh2-scp 拉进 server 子进程与主进程的启动图（实测 ~50-100ms）。
 * 唯一真源仍是这里，transfer.js 转发导出保持兼容，session-server（真正用
 * Transfer 实例的地方）不受影响。
 */

const transferKeys = [
  'pause',
  'resume',
  'destroy'
]

module.exports = {
  transferKeys
}
