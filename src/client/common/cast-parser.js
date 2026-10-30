/**
 * G2：asciinema v2（`.cast`）录制文件解析
 *
 * 只做读，不碰录制端（`session-recorder.js` 的格式是唯一的写入方）：
 * 首行 header `{version,width,height,timestamp}`，其后每行 `[相对秒, 类型, 数据]`。
 *
 * 口径：
 * - header 坏掉直接抛错——没有宽高就没法定终端尺寸，"尽力播一下"只会画出满屏乱码；
 * - header 之后**单行**坏掉（截断、非数组、时间不是数）跳过并计数，
 *   录制是边写边 flush 的，尾部半行是常态而不是异常；
 * - 时间戳按"录制中的相对秒"用，负数钳到 0；**不重排事件**：
 *   录制端按到达顺序落盘，重排等于把输出顺序改掉，行会串台；
 * - `i`（键盘输入）事件不参与画面回放，播放器据此画输入徽标。
 */
import { stripAnsi } from '../components/terminal/automation/strip-ansi.js'

// 列表里"首条命令"的展示上限（字符）：命令本身可能带一大串参数
export const CAST_CMD_MAX = 80

// 回车/换行截断，制表符压成空格
const SPACE_RE = /[ \t]+/g

export class CastFormatError extends Error {}

const isPosInt = v => Number.isFinite(v) && v > 0

/**
 * 解析整份 cast 文本。
 * @returns {{header: object|null, events: Array, badLines: number, duration: number, empty: boolean}}
 */
export function parseCast (text) {
  const lines = String(text == null ? '' : text).split('\n')
  if (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }
  const first = lines.findIndex(l => l.trim() !== '')
  if (first < 0) {
    // 空文件（0 字节 / 只有空白）：可打开，由界面给"这段录制没有内容"
    return { header: null, events: [], badLines: 0, duration: 0, empty: true }
  }
  let header
  try {
    header = JSON.parse(lines[first].trim())
  } catch (e) {
    throw new CastFormatError('cast header is not valid JSON')
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new CastFormatError('cast header must be an object')
  }
  if (!isPosInt(header.width) || !isPosInt(header.height)) {
    throw new CastFormatError('cast header must carry positive width/height')
  }
  const events = []
  let badLines = 0
  let duration = 0
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      continue
    }
    let row
    try {
      row = JSON.parse(line)
    } catch (e) {
      badLines++
      continue
    }
    if (!Array.isArray(row) || row.length < 3) {
      badLines++
      continue
    }
    const t = Number(row[0])
    const type = typeof row[1] === 'string' ? row[1] : ''
    const data = typeof row[2] === 'string' ? row[2] : ''
    if (!Number.isFinite(t) || !type) {
      badLines++
      continue
    }
    const at = Math.max(0, t)
    events.push({ at, type, data })
    if (at > duration) {
      duration = at
    }
  }
  return { header, events, badLines, duration, empty: false }
}

// 输出/输入分开数：播放器的"不丢事件"判据按这两项与解析结果对账
export const castCounts = events => {
  let out = 0
  let input = 0
  for (const ev of events) {
    if (ev.type === 'o') {
      out++
    } else if (ev.type === 'i') {
      input++
    }
  }
  return { out, input, other: events.length - out - input }
}

// 输入事件按到达顺序拼成"这次会话敲了什么"：回车换行 = 分隔（提交），
// 退格 = 删掉前一个字符（用户在命令行上真删了），其余控制字符丢弃
export const castCommands = events => {
  const cmds = []
  let cur = ''
  for (const ev of events) {
    if (ev.type !== 'i') {
      continue
    }
    const plain = stripAnsi(ev.data)
    for (const ch of plain) {
      if (ch === '\r' || ch === '\n') {
        if (cur) {
          cmds.push(cur)
          cur = ''
        }
      } else if (ch === '\b' || ch === '\x7f') {
        cur = cur.slice(0, -1)
      } else if (ch === '\t') {
        cur += ' '
      } else if (ch >= ' ') {
        cur += ch
      }
    }
  }
  if (cur) {
    cmds.push(cur)
  }
  return cmds
}

// 列表用的"首条命令"：没有输入事件（未开 recordInput）时回 null，界面画「—」
export const firstCastCommand = events => {
  const cmds = castCommands(events)
  if (!cmds.length) {
    return null
  }
  const one = String(cmds[0]).replace(SPACE_RE, ' ').trim()
  if (!one) {
    return null
  }
  return one.length > CAST_CMD_MAX ? one.slice(0, CAST_CMD_MAX) + '…' : one
}

/**
 * 把事件切成"每毫秒一格"的帧，供播放器拖进度时定位。
 * 同一帧内的事件保持原顺序；帧号 = floor(at * 1000)，浮点秒在这里定尺。
 */
export const castFrames = events => {
  const map = new Map()
  for (let i = 0; i < events.length; i++) {
    const key = Math.floor(events[i].at * 1000)
    const arr = map.get(key)
    if (arr) {
      arr.push(i)
    } else {
      map.set(key, [i])
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, idxs]) => ({ ms, idxs }))
}
