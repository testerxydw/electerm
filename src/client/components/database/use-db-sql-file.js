// #28 SQL 文件读写（cluster #28 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「编辑器缓冲 ↔ .sql 文件」这一个职责域：
//   sqlFile            当前绑定文件（null = 尚未落盘的草稿）；savedText 是上次读写时的
//                      原文，脏标记按它原样比较（判据在 common/sql-file）
//   sqlFileDirty       派生值，不是 state
//   sqlBufferReplacable / confirmReplaceBuffer
//                      打开前问一声：绑定文件且没改过 → 覆盖等于重读同一份，不必问；
//                      草稿非空或已脏 → 弹确认
//   openSqlFile        对话框走主进程（openDialog 自带上次目录记忆），读文件走统一 ws fs 通道
//   saveSqlFile        没有绑定路径时弹保存对话框；成功后 savedText 跟上，脏标记自然消失
//
// 不搬 sqlText：它是 SQL 编辑器的核心状态，全文件几十处消费，属另一个职责域。
// 本 hook 只通过形参读写它。
//
// 行为零变更：整段逐字搬迁（state 原 415–418 共 4 行，handler 原 1866–1938 共 73 行）。
//
// 不回流（仅本簇内部使用）：setSqlFile / sqlBufferReplacable / confirmReplaceBuffer。
import { useState } from 'react'
import { Modal } from 'antd'
import message from '../common/message'
import fs from '../../common/fs'
import {
  sqlFileBaseName,
  isSqlFileDirty,
  sqlOpenDialogOptions,
  sqlSaveDialogOptions,
  withSqlExt
} from '../../common/sql-file'

const e = window.translate

export function useDbSqlFile ({ sqlText, setSqlText }) {
  // H6c：当前编辑器绑定的 .sql 文件。null = 尚未落盘的草稿；
  // savedText 是上次读写时的原文，脏标记按它原样比较（判断在 common/sql-file）
  const [sqlFile, setSqlFile] = useState(null)
  const sqlFileDirty = !!sqlFile && isSqlFileDirty(sqlText, sqlFile.savedText)

  // H6c：当前缓冲是否已有"会被打开动作覆盖"的内容。
  // 绑定文件且没改过 → 覆盖等于重读同一份，不必问；草稿非空或已脏 → 问一声
  const sqlBufferReplacable = () => (
    sqlFile ? !sqlFileDirty : !sqlText.trim()
  )

  const confirmReplaceBuffer = () => new Promise(resolve => {
    if (sqlBufferReplacable()) {
      resolve(true)
      return
    }
    Modal.confirm({
      title: e('dbSqlFileReplaceTitle'),
      content: e('dbSqlFileReplaceWarn'),
      okText: e('dbSqlFileReplaceOk'),
      cancelText: e('cancel'),
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })

  // H6c：打开 .sql。对话框走主进程（preload 的 openDialog 已带上次目录记忆），
  // 读文件走统一的 ws fs 通道（utf8）
  const openSqlFile = async () => {
    if (!(await confirmReplaceBuffer())) {
      return
    }
    let files
    try {
      files = await window.api.openDialog(sqlOpenDialogOptions())
    } catch (err) {
      message.error(e('dbSqlFileReadErr') + ' ' + (err && err.message ? err.message : err))
      return
    }
    if (!files || !files.length) {
      return
    }
    const filePath = files[0]
    try {
      const text = await fs.readFile(filePath)
      setSqlText(text)
      setSqlFile({ path: filePath, savedText: text })
      message.success(e('dbSqlFileOpened').replace('{file}', sqlFileBaseName(filePath)))
    } catch (err) {
      message.error(e('dbSqlFileReadErr') + ' ' + (err && err.message ? err.message : err))
    }
  }

  // H6c：保存 .sql。没有绑定路径时弹保存对话框；保存成功后 savedText 跟上，
  // 脏标记自然消失
  const saveSqlFile = async () => {
    let filePath = sqlFile && sqlFile.path
    if (!filePath) {
      let res
      try {
        res = await window.api.saveDialog(sqlSaveDialogOptions(''))
      } catch (err) {
        message.error(e('dbSqlFileWriteErr') + ' ' + (err && err.message ? err.message : err))
        return
      }
      if (!res || res.canceled || !res.filePath) {
        return
      }
      filePath = withSqlExt(res.filePath)
    }
    try {
      await fs.writeFile(filePath, sqlText)
      setSqlFile({ path: filePath, savedText: sqlText })
      message.success(e('dbSqlFileSaved').replace('{file}', sqlFileBaseName(filePath)))
    } catch (err) {
      message.error(e('dbSqlFileWriteErr') + ' ' + (err && err.message ? err.message : err))
    }
  }
  return {
    sqlFile,
    sqlFileDirty,
    openSqlFile,
    saveSqlFile
  }
}
