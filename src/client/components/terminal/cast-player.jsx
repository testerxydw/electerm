/**
 * G2：cast 回放器（只读 xterm + 虚拟时钟）
 *
 * 时钟自己走，不跟真机对齐：一帧该写多少条就写多少条。按帧节流看着省，
 * 实际就是"4x 会丢事件"的那种写法。
 *
 * 三处刻意的取舍：
 * - 尺寸按 header 定死，窗口变化不重排——重排会把录制里已经折行的内容挪位，
 *   回放出来的画面就不是当时那一屏了；
 * - `i`（键盘输入）不写进终端：录制时它没上屏，回放时上屏就是假画面，
 *   改画底部输入徽标（按"敲完一行"更新，不是每个字符闪一次）；
 * - 往回拖 = 重置终端重放到那一点。xterm 没有"逆向删除"，
 *   只往前写会留下后半段画面，那是错的画面而不是"少画一点"。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Button, Slider, Alert, Spin } from 'antd'
import { loadTerminal } from './xterm-loader.js'
import { copy } from '../../common/clipboard'
import { parseCast, castCommands, CastFormatError } from '../../common/cast-parser.js'
import './cast-player.styl'

const e = window.translate

const SPEEDS = [0.5, 1, 2, 4]
// 一帧最多补这么多毫秒：切到别的窗口再回来，rAF 停摆期间的"欠账"不补
const MAX_FRAME_MS = 250

const pad2 = n => String(n).padStart(2, '0')
const fmtTime = ms => {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60)
}
const fmtStart = ts => {
  if (!Number.isFinite(ts)) {
    return '—'
  }
  const d = new Date(ts * 1000)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

export default function CastPlayer (props) {
  const { open, rec, themeConfig, config = {}, onClose } = props
  const name = (rec && rec.name) || ''

  const boxRef = useRef(null)
  const termRef = useRef(null)
  const eventsRef = useRef([])
  const schedRef = useRef([])
  const idxRef = useRef(0)
  const writtenRef = useRef(0)
  const clockRef = useRef(0)
  const rafRef = useRef(0)
  const lastTsRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(1)
  const typeBufRef = useRef('')
  const cmdRef = useRef('')
  const totalRef = useRef(0)

  const [load, setLoad] = useState({ loading: true })
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tick, setTick] = useState({ pos: 0, written: 0 })
  const [cmd, setCmd] = useState('')

  // 读文件 + 解析：失败只影响这个弹层，列表照常
  useEffect(() => {
    if (!open || !name) {
      return undefined
    }
    let dead = false
    setLoad({ loading: true })
    window.pre.runGlobalAsync('readRecording', name)
      .then(res => {
        if (dead) {
          return
        }
        let parsed
        try {
          parsed = parseCast(res.text)
        } catch (err) {
          setLoad({
            loading: false,
            error: err instanceof CastFormatError ? e('castInvalidFile') : String((err && err.message) || err)
          })
          return
        }
        // 调度时间单调递增：录制端落盘顺序即输出顺序，这里只把"倒流"钳平成 0 延迟
        const sched = []
        let prev = 0
        for (const ev of parsed.events) {
          const ms = Math.max(prev, Math.round(ev.at * 1000))
          sched.push(ms)
          prev = ms
        }
        eventsRef.current = parsed.events
        schedRef.current = sched
        totalRef.current = sched.length ? sched[sched.length - 1] : 0
        idxRef.current = 0
        writtenRef.current = 0
        clockRef.current = 0
        typeBufRef.current = ''
        cmdRef.current = ''
        setCmd('')
        setTick({ pos: 0, written: 0 })
        setLoad({
          loading: false,
          empty: !parsed.events.length,
          truncated: !!res.truncated,
          badLines: parsed.badLines,
          header: parsed.header,
          total: parsed.events.length
        })
      })
      .catch(err => {
        if (!dead) {
          setLoad({ loading: false, error: String((err && err.message) || err) })
        }
      })
    return () => {
      dead = true
    }
  }, [open, name])

  // 输入事件 → 徽标：攒到换行才算"敲完一条"，退格在 castCommands 里已经生效
  const feedTyping = data => {
    typeBufRef.current += data
    const buf = typeBufRef.current
    const nl = Math.max(buf.lastIndexOf('\r'), buf.lastIndexOf('\n'))
    if (nl < 0) {
      return
    }
    const cmds = castCommands([{ type: 'i', data: buf }])
    if (cmds.length) {
      cmdRef.current = cmds[cmds.length - 1]
    }
    typeBufRef.current = buf.slice(nl + 1)
  }

  const pump = upto => {
    const term = termRef.current
    const events = eventsRef.current
    const sched = schedRef.current
    let i = idxRef.current
    let buf = ''
    while (i < sched.length && sched[i] <= upto) {
      const ev = events[i]
      if (ev.type === 'o') {
        buf += ev.data
        writtenRef.current++
      } else if (ev.type === 'i') {
        if (buf && term) {
          term.write(buf)
          buf = ''
        }
        feedTyping(ev.data)
      }
      i++
    }
    if (buf && term) {
      term.write(buf)
    }
    idxRef.current = i
  }

  const resetScreen = useCallback(() => {
    const term = termRef.current
    idxRef.current = 0
    writtenRef.current = 0
    typeBufRef.current = ''
    cmdRef.current = ''
    if (term) {
      term.reset()
    }
  }, [])

  const seek = useCallback(ms => {
    const total = totalRef.current
    const target = Math.max(0, Math.min(Number(ms) || 0, total))
    // 往回拖只能重画：先清屏，再把 0..target 的内容一次性写进去
    if (target < clockRef.current) {
      resetScreen()
    }
    clockRef.current = target
    pump(target)
    setTick({ pos: target, written: writtenRef.current })
    setCmd(cmdRef.current)
  }, [resetScreen])

  const stopRaf = () => {
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }

  const frame = useCallback(ts => {
    rafRef.current = 0
    if (!playingRef.current) {
      return
    }
    const last = lastTsRef.current || ts
    lastTsRef.current = ts
    clockRef.current += Math.min(Math.max(ts - last, 0), MAX_FRAME_MS) * speedRef.current
    const total = totalRef.current
    if (clockRef.current >= total) {
      clockRef.current = total
      pump(total)
      playingRef.current = false
      setPlaying(false)
    } else {
      pump(clockRef.current)
      rafRef.current = window.requestAnimationFrame(frame)
    }
    setTick({ pos: clockRef.current, written: writtenRef.current })
    setCmd(cmdRef.current)
  }, [])

  const play = () => {
    if (playingRef.current || !totalRef.current) {
      return
    }
    if (clockRef.current >= totalRef.current) {
      seek(0)
    }
    playingRef.current = true
    lastTsRef.current = 0
    setPlaying(true)
    rafRef.current = window.requestAnimationFrame(frame)
  }

  const pause = () => {
    playingRef.current = false
    stopRaf()
    setPlaying(false)
  }

  const toggle = () => {
    if (playingRef.current) {
      pause()
    } else {
      play()
    }
  }

  const changeSpeed = s => {
    speedRef.current = s
    setSpeed(s)
  }

  const copyCommands = () => {
    const cmds = castCommands(eventsRef.current)
    if (!cmds.length) {
      return
    }
    copy(cmds.join('\n'))
  }

  // 建/销只读终端：跟着 open 与 header 走（header 到了才有宽高）
  useEffect(() => {
    if (!open || load.loading || load.error || !boxRef.current) {
      return undefined
    }
    let dead = false
    let term = null
    const header = load.header || {}
    // 主题/字体允许父级传入；没传就现场取一次（只在建终端时取，播放帧里不取）
    const cfg = config && Object.keys(config).length ? config : window.store.config
    const theme = themeConfig || window.store.getThemeConfig()
    loadTerminal().then(Terminal => {
      if (dead || !boxRef.current) {
        return
      }
      term = new Terminal({
        cols: header.width,
        rows: header.height,
        disableStdin: true,
        cursorBlink: false,
        cursorStyle: 'underline',
        scrollback: cfg.scrollback,
        fontFamily: cfg.fontFamily,
        fontSize: cfg.fontSize,
        theme
      })
      termRef.current = term
      term.open(boxRef.current)
      if (load.empty) {
        // 空录制也开得起：给一句提示而不是画一块黑屏
        term.write('\x1b[90m' + e('castEmpty') + '\x1b[0m')
      } else {
        // 终端是异步建的，建好前时钟可能已经走过几毫秒：按当前位置补画
        pump(clockRef.current)
      }
    }).catch(err => {
      if (!dead) {
        setLoad(s => ({ ...s, error: String((err && err.message) || err) }))
      }
    })
    return () => {
      dead = true
      playingRef.current = false
      stopRaf()
      termRef.current = null
      if (term) {
        term.dispose()
      }
    }
  }, [open, load.loading, load.error, load.header, load.empty])

  // 关掉弹层就把时钟作废：下次开是另一段录制，不该带着上一段的位置
  useEffect(() => {
    if (!open) {
      playingRef.current = false
      stopRaf()
      setPlaying(false)
    }
    return undefined
  }, [open])

  const total = totalRef.current
  const hasCmds = eventsRef.current.some(ev => ev.type === 'i')
  const meta = []
  if (load.header) {
    meta.push(load.header.width + '×' + load.header.height)
    meta.push(fmtStart(load.header.timestamp))
  }
  if (!load.loading && !load.error) {
    meta.push(e('castEvents') + ': ' + (load.total || 0))
    if (load.badLines) {
      meta.push(e('castBadLines') + ': ' + load.badLines)
    }
  }

  return (
    <Modal
      className='cast-player-modal'
      open={open}
      width={920}
      title={e('castReplay') + (name ? ' · ' + name : '')}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <div
        className='cast-player'
        data-cast-pos={Math.round(tick.pos)}
        data-cast-written={tick.written}
        data-cast-total={load.total || 0}
        data-cast-playing={playing ? '1' : '0'}
        data-cast-speed={speed}
        data-cast-cmd={cmd}
      >
        {
          load.loading
            ? <div className='cast-player-loading'><Spin /></div>
            : null
        }
        {
          load.error
            ? <Alert className='cast-player-error' type='error' showIcon message={load.error} />
            : null
        }
        {
          load.truncated
            ? <Alert className='cast-player-warn' type='warning' showIcon message={e('castTruncated')} />
            : null
        }
        <div className='cast-player-meta'>{meta.join(' · ')}</div>
        <div className='cast-player-box' ref={boxRef} />
        <div className='cast-player-bar'>
          <Button
            size='small'
            type='primary'
            disabled={!!load.loading || !!load.error || !total}
            onClick={toggle}
          >
            {playing ? e('castPause') : e('castPlay')}
          </Button>
          <span className='cast-player-speeds'>
            {
              SPEEDS.map(s => (
                <Button
                  key={s}
                  size='small'
                  type={s === speed ? 'primary' : 'default'}
                  ghost={s === speed}
                  onClick={() => changeSpeed(s)}
                >
                  {s}x
                </Button>
              ))
            }
          </span>
          <Slider
            className='cast-player-scrub'
            min={0}
            max={Math.max(1, total)}
            step={10}
            value={Math.round(tick.pos)}
            onChange={seek}
            disabled={!!load.loading || !!load.error}
            tooltip={{ formatter: v => fmtTime(v) }}
          />
          <span className='cast-player-time'>{fmtTime(tick.pos)} / {fmtTime(total)}</span>
          <Button size='small' disabled={!hasCmds} onClick={copyCommands} title={e('castCopyHint')}>
            {e('castCopyCommands')}
          </Button>
        </div>
        <div className='cast-player-typed' data-cast-typed={cmd}>
          {cmd ? '⌨ ' + cmd + ' ⏎' : ''}
        </div>
      </div>
    </Modal>
  )
}
