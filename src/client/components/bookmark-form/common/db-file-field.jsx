/**
 * H8a：本地文件引擎（SQLite）的库文件字段 = 输入框 + 原生选择器。
 *
 * 为什么留着手输入口：`:memory:` 与"还没建出来的新库路径"都要能填，而选择器只能
 * 挑已存在的文件；也方便从终端里拷来的路径直接粘贴。
 * 登记为字段类型 'dbFilePicker'（见 ./fields.jsx），只在 dbType=sqlite 时显示。
 */
import { useState } from 'react'
import { Button, Form, Input } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import {
  normalizeDbFilePath,
  sqliteFileDialogOptions
} from '../../../common/db-file.js'

const e = window.translate
const FormItem = Form.Item

export default function DbFileField ({ form, layout, label, name, rules }) {
  const [picking, setPicking] = useState(false)

  const pick = async () => {
    setPicking(true)
    try {
      // window.api.openDialog 是主进程的 dialog.showOpenDialogSync
      const files = await window.api
        .openDialog(sqliteFileDialogOptions(e('dbFileChoose')))
        .catch(() => null)
      const path = files && files.length ? files[0] : ''
      if (path) {
        form.setFieldsValue({ [name]: normalizeDbFilePath(path) })
      }
    } finally {
      setPicking(false)
    }
  }

  return (
    <FormItem
      {...layout}
      label={label}
      name={name}
      rules={rules}
    >
      <Input
        allowClear
        placeholder={e('dbFilePlaceholder')}
        // 失焦时归一（trim + 剥成对引号）。不用 Form.Item 的 normalize：那个每次按键都跑，
        // 路径里带空格就打不出来（"My DB/app.db" 会被 trim 成 "MyDB/app.db"）。
        // 也来不及在提交后收拾——主进程拿着带引号的路径只会报"打不开库文件"
        onBlur={ev => {
          const v = normalizeDbFilePath(ev.target.value)
          if (v !== ev.target.value) {
            form.setFieldsValue({ [name]: v })
          }
        }}
        addonAfter={
          <Button
            size='small'
            type='text'
            loading={picking}
            icon={<FolderOpenOutlined />}
            title={e('dbFileChoose')}
            onClick={pick}
          />
        }
      />
    </FormItem>
  )
}
