/**
 * H6c：SQL 查询文件（.sql）的纯计算部分。
 *
 * 组件只做对话框/读写 IO 与渲染；路径取名字、脏标记、页签文案这些判断
 * 放在这里，单测可以直接钉住。脏标记按"当前文本 !== 上次读写时的文本"
 * 原样比较：不做换行归一的话，保存后再读回来会被判成脏（编辑器不会改写
 * 换行，归一反而制造差异）。
 */

export const SQL_FILE_EXT = 'sql'

const SQL_FILE_FILTERS = [
  { name: 'SQL', extensions: [SQL_FILE_EXT] },
  { name: 'All files', extensions: ['*'] }
]

export function sqlFileBaseName (filePath) {
  const p = String(filePath == null ? '' : filePath)
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function isSqlFileDirty (text, savedText) {
  return String(text == null ? '' : text) !== String(savedText == null ? '' : savedText)
}

// 页签文案：有文件时显示文件名（脏了补 " •"），没有文件时保持原来的 "SQL"
export function sqlFileTabLabel (filePath, dirty) {
  const base = sqlFileBaseName(filePath)
  if (!base) {
    return 'SQL'
  }
  return base + (dirty ? ' •' : '')
}

export function sqlOpenDialogOptions () {
  return {
    title: 'Open SQL file',
    properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
    filters: SQL_FILE_FILTERS
  }
}

// 没有路径时给一个带扩展名的默认文件名，免得用户拿到无后缀的文件
export function sqlSaveDialogOptions (filePath) {
  return {
    title: 'Save SQL file',
    defaultPath: sqlFileBaseName(filePath) || 'query.' + SQL_FILE_EXT,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
    filters: SQL_FILE_FILTERS
  }
}

// 保存前把用户可能省略的扩展名补上（Linux 下 GTK 不会自动补）
export function withSqlExt (filePath) {
  const p = String(filePath == null ? '' : filePath)
  if (!p) {
    return p
  }
  return /\.[A-Za-z0-9]+$/.test(sqlFileBaseName(p)) ? p : p + '.' + SQL_FILE_EXT
}
