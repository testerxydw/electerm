/**
 * 统一查找条 UI（SSH/终端页与数据库页共用；查找引擎由调用方注入）。
 * 结构：输入框（自动聚焦/allowClear/Esc 关闭/Enter=下一个）+
 *       选项插槽（suffix）+ (i/n) 计数 + 上一个/下一个 + 关闭
 */
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CloseCircleOutlined
} from '@ant-design/icons'
import InputAutoFocus from './input-auto-focus'
import './search-bar.styl'

export default function SearchBar (props) {
  const {
    value,
    onChange,
    onClose,
    onPrev,
    onNext,
    matchIndex = 0,
    matchCount = 0,
    placeholder,
    suffix,
    className
  } = props
  return (
    <div className={'search-bar' + (className ? ' ' + className : '')}>
      <InputAutoFocus
        size='small'
        allowClear
        selectall
        className='search-bar-input'
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        suffix={suffix}
        onPressEnter={onNext}
        onKeyDown={ev => {
          if (ev.key === 'Escape') {
            onClose()
          }
        }}
      />
      {
        matchCount
          ? <span className='search-bar-count'>({matchIndex + 1}/{matchCount})</span>
          : null
      }
      <ArrowLeftOutlined className='search-bar-act' onClick={onPrev} />
      <ArrowRightOutlined className='search-bar-act' onClick={onNext} />
      <CloseCircleOutlined className='search-bar-act search-bar-close' onClick={onClose} />
    </div>
  )
}
