/**
 * 右面板「传输」页（对齐重设计草图 .panel-r 传输页）
 * 直接复用既有传输队列组件 TransferModal（列表 + 历史 + 进度），不新造数据。
 */

import { auto } from 'manate/react'
import TransferModal from '../sidebar/transfer-modal'
import './transfer-panel.styl'

const e = window.translate

export default auto(function TransferPanel ({ store }) {
  const fileTransfers = store.fileTransfers || []
  const transferHistory = store.transferHistory || []
  const empty = !fileTransfers.length && !transferHistory.length
  return (
    <div className='transfer-panel'>
      <div className='transfer-panel-head'>
        <span>{e('transferPanel')}</span>
        <span className='transfer-panel-count'>{fileTransfers.length}</span>
      </div>
      {
        empty
          ? (
            <div className='transfer-panel-hint'>
              {e('transferEmpty')}
            </div>
            )
          : (
            <TransferModal
              fileTransfers={fileTransfers}
              transferHistory={transferHistory}
              transferTab={store.transferTab}
            />
            )
      }
    </div>
  )
})
