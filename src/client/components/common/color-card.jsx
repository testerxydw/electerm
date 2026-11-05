import { ColorPicker as AntColorPicker } from 'antd'
import { defaultColors, getRandomHexColor } from '../../common/rand-hex-color.js'
import { HexInput } from './hex-input.jsx'
import './color-card.styl'

/**
 * 色卡：色点一排排直接点（书签表单和页签右键共用这一张），
 * 右上角再留一个可拖动的取色器给"色点里没有"的场合。
 *
 * onChange 是"选色进行中"（拖动取色器，每动一下就回调，面板不该关）；
 * onCommit 是"就要这个色"（点色点 / random / 提交 hex，调用方可以顺手收起）。
 */
export function ColorCard ({ value, onChange, onCommit, isRgba }) {
  const commit = (hex) => {
    if (onCommit) {
      return onCommit(hex)
    }
    onChange(hex)
  }
  return (
    <div className='color-picker-box'>
      <div className='fix'>
        <div className='fleft color-picker-defaults'>
          {
            [...defaultColors, 'random'].map((color) => {
              const style = color === 'random' ? { color: '#000' } : { color }
              const p = {
                className: 'color-picker-unit',
                style,
                onClick: () => {
                  if (color === 'random') return commit(getRandomHexColor())
                  commit(color)
                }
              }
              return <div {...p} key={color}>● {color}</div>
            })
          }
        </div>
        <div className='fright'>
          <AntColorPicker
            value={value}
            onChange={(color) => onChange(isRgba ? color.toRgbString() : color.toHexString())}
          />
        </div>
      </div>
      <div className='pd1y'>
        <HexInput value={value} onChange={commit} />
      </div>
    </div>
  )
}
