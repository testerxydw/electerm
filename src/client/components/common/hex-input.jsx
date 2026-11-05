import { Input } from 'antd'
import { useEffect, useState } from 'react'
import { CheckOutlined } from '@ant-design/icons'

const norm = s => String(s || '').replace('#', '')

export const HexInput = (props) => {
  const [v, setV] = useState(norm(props.value))
  // 上次见过的 value。只有"外部真的换过色"才覆盖草稿：
  // 否则用户打到一半会被自己还没提交的输入顶回去
  const [seen, setSeen] = useState(norm(props.value))
  useEffect(() => {
    const nv = norm(props.value)
    if (nv !== seen) {
      setSeen(nv)
      setV(nv)
    }
  }, [props.value, seen])
  const handleChange = (event) => {
    const vv = event.target.value
    const hexRegex = /^[0-9a-fA-F]{0,6}$/
    if (hexRegex.test(vv)) setV(vv)
  }
  function submit () {
    props.onChange('#' + v)
  }
  function renderAfter () {
    if (!/^[0-9a-fA-F]{6}$/.test(v)) return null
    return <CheckOutlined className='pointer' onClick={submit} />
  }
  return (
    <Input
      prefix='#' {...props}
      value={v}
      onChange={handleChange}
      suffix={renderAfter()}
    />
  )
}
