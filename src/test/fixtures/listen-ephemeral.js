/**
 * 测试用的「临时端口」helper：`listen(0)` 让内核在同一次绑定里就把端口分给
 * server，不存在「先探测后监听」的窗口 —— `find-free-port` 那对组合正是这个
 * TOCTOU 的来源（两个进程并发全量测试时互相抢同一网段，出现 ~20% 的假红）。
 *
 * 失败永不吞掉：真正绑定失败时把地址与 errno 一起报出来，否则静默失败会被
 * 当成产品缺陷写进测试报告。共用这一份实现，不要再复制第三份。
 * @param {import('node:net').Server} server
 * @param {string} [host]
 * @returns {Promise<number>} 内核实际分配的端口
 */
function listenOnEphemeralPort (server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening)
      reject(new Error(
        `fake device failed to listen on ${host}:0 (${err.code || 'unknown'}): ${err.message}`
      ))
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
}

module.exports = { listenOnEphemeralPort }
