/**
 * sessions not proper closed related functions
 */

import { debounce } from 'lodash-es'
import React from 'react'
import { notification } from 'antd'
import message from '../components/common/message'
import ShowItem from '../components/common/show-item'
import { refs } from '../components/common/ref'

const e = window.translate

export default Store => {
  Store.prototype.zoomTerminal = debounce(function (delta) {
    const term = refs.get('term-' + window.store.activeTabId)
    if (!term) {
      return
    }
    term.zoom(delta > 0 ? 1 : -1)
  }, 500)

  // T5-4b 会话录制开关：开始时主进程建 cast 文件并写 UI 状态（attach addon
  // 的 SessionRecorder 消费 recState 攒缓冲落盘）；停止时仅删状态，
  // recorder 在下一次输出或 dispose 时收尾落盘尾部。
  Store.prototype.toggleSessionRecord = async function (tabId) {
    const { store } = window
    const rec = store.recState[tabId]
    if (rec) {
      delete store.recState[tabId]
      // T5-4e 停录通知可点击: 一键在文件管理器中定位 cast 文件。
      // 复用 term-log 停录通知同款 ShowItem 链接模式 (真机验证过的点击通道,
      // 直调 window.pre.showItemInFolder); antd 6 静态 notification 的卡片级
      // onClick 真机无响应, 弃用。cast 文件无默认关联程序, 定位文件夹比
      // openPath 更通用
      notification.open({
        key: 'rec-done-' + tabId,
        message: e('stopRecord'),
        description: React.createElement(ShowItem, { to: rec.path }, rec.path),
        duration: 12
      })
      return
    }
    const path = await window.pre.runGlobalAsync('createRecordFile')
    if (!path) {
      return
    }
    const term = refs.get('term-' + tabId)?.term
    store.recState[tabId] = {
      path,
      startTime: Date.now(),
      width: term?.cols || 80,
      height: term?.rows || 24
    }
    // 输入录制默认关闭; 打开时首次开录提醒隐私边界（密码提示仍自动避录）
    if (store.config.recordInput) {
      message.warning('Keyboard input recording is on; password prompts are still skipped.')
    }
    message.success(e('record') + ': ' + path)
  }

  // T5-4f 录制暂停/继续：只切 recState.paused, 录制引擎按该标志跳过输出与输入
  Store.prototype.toggleSessionRecordPause = function (tabId) {
    const rec = window.store.recState[tabId]
    if (!rec) {
      return
    }
    rec.paused = !rec.paused
  }
}
