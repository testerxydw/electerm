import { Input, Radio, Select, Space } from 'antd'
import { useState } from 'react'
import BookmarkTransport from '../tree-list/bookmark-transport'
import Modal from '../common/modal'
import download from '../../common/download'
import time from '../../common/time'
import {
  addImportedRules,
  userGroupNames
} from '../../common/keyword-groups'

const e = window.translate

// 导入方式询问：新建子分组（默认取文件名）/ 并入已有分组。
// 选择结果写进这个共享对象，Modal.confirm 的 onOk 里读取（避免把弹窗状态挂到父组件）
function ImportAsk ({ choice, defaultValue, groups }) {
  const [mode, setMode] = useState('new')
  const [name, setName] = useState(defaultValue)
  const [target, setTarget] = useState(groups[0] ? groups[0].name : '')

  const change = (next) => {
    setMode(next.mode)
    if (next.mode !== undefined) {
      choice.mode = next.mode
      choice.group = next.mode === 'new' ? name : target
    }
    if (next.name !== undefined) {
      setName(next.name)
      choice.group = next.name
    }
    if (next.target !== undefined) {
      setTarget(next.target)
      choice.group = next.target
    }
  }

  choice.mode = mode
  choice.group = mode === 'new' ? name : target

  return (
    <div className='kw-import-ask'>
      <Radio.Group
        value={mode}
        onChange={ev => change({ mode: ev.target.value })}
      >
        <Radio value='new'>{e('kwImportNew')}</Radio>
        <Radio value='merge'>{e('kwImportMerge')}</Radio>
      </Radio.Group>
      <div className='pd1y'>
        {
          mode === 'new'
            ? (
              <Input
                size='small'
                value={name}
                placeholder={e('kwGroupName')}
                onChange={ev => change({ name: ev.target.value })}
              />
              )
            : (
              <Select
                size='small'
                style={{ width: '100%' }}
                value={target}
                onChange={value => change({ target: value })}
                options={groups.map(g => ({
                  value: g.name,
                  label: g.name || e('kwManualGroup')
                }))}
              />
              )
        }
      </div>
      <div className='kw-import-tip'>{e('kwImportTip')}</div>
    </div>
  )
}

export default class KeywordsTransport extends BookmarkTransport {
  name = 'keywords-highlight'

  beforeUpload = async (file) => {
    const { store } = this.props
    const txt = file.fileContent !== undefined
      ? file.fileContent
      : await window.fs.readFile(file.filePath)
    let rules
    try {
      rules = JSON.parse(txt)
    } catch (err) {
      store.onError(err)
      return false
    }
    if (!Array.isArray(rules)) {
      store.onError(new Error('keywords file should be a JSON array'))
      return false
    }
    const raw = file.fileName || file.filePath || 'keywords.json'
    const fileName = String(raw).split(/[\\/]/).pop()
    const groups = this.getUserGroups()
    const choice = { mode: 'new', group: fileName }
    Modal.confirm({
      title: e('kwImportAsk'),
      width: 420,
      content: (
        <ImportAsk
          choice={choice}
          defaultValue={fileName}
          groups={groups}
        />
      ),
      okText: e('confirm'),
      cancelText: e('cancel'),
      onOk: () => this.applyImport(rules, choice.group || '')
    })
    return false
  }

  getUserGroups () {
    const { store } = this.props
    return [
      { name: '' },
      ...userGroupNames(store.config.keywords).map(name => ({ name }))
    ]
  }

  applyImport (rules, group) {
    const { store } = this.props
    store.setConfig({
      keywords: addImportedRules(store.config.keywords, rules, group)
    })
    setTimeout(this.props.resetKeywordForm, 100)
  }

  handleDownload = () => {
    const { store } = this.props
    const arr = store.config.keywords || []
    const txt = JSON.stringify(arr, null, 2)
    const stamp = time(undefined, 'YYYY-MM-DD-HH-mm-ss')
    download('electerm-' + this.name + '-' + stamp + '.json', txt)
  }

  render () {
    // 「预设」入口已并入设置页的预设分组（勾选即应用），此处只保留导入/导出
    return (
      <Space.Compact>
        {this.renderExport()}
        {this.renderImport()}
      </Space.Compact>
    )
  }
}
