import {
  Form,
  Select,
  Space,
  Button
} from 'antd'
import { formItemLayout } from '../../common/form-layout'
import {
  DownOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  UpOutlined
} from '@ant-design/icons'
import { useEffect, useState } from 'react'
import InputConfirm from '../common/input-confirm'

const FormItem = Form.Item
const FormList = Form.List
const OptionSel = Select.Option
const e = window.translate

// 折叠态可见高度 (约 6 行)；条目少于该阈值不出现折叠按钮
const COLLAPSED_MAX_HEIGHT = 220
const COLLAPSE_THRESHOLD = 8

export default function KeywordForm (props) {
  const {
    formData
  } = props
  const [formChild] = Form.useForm()
  // 预设条目多 (100+)，默认折叠展示，全部渲染保证表单提交完整
  const [expanded, setExpanded] = useState(false)
  function handleTrigger () {
    formChild.submit()
  }

  function handleFinish (data) {
    props.submit(data)
  }

  function checker (_, value) {
    try {
      return Promise.resolve(!!new RegExp(`(${value})`, 'gi'))
    } catch (e) {
      console.log(e, 'check keyword error')
      return Promise.reject(e)
    }
  }

  function renderItem (field, i, add, remove) {
    return (
      <Space.Compact
        align='center'
        key={field.key}
        className='mg3r mg2b'
      >
        <FormItem
          noStyle
          required
          name={[field.name, 'keyword']}
          rules={[{ validator: checker }]}
        >
          <InputConfirm
            addonBefore={renderBefore(field.name)}
            onChange={handleTrigger}
          />
        </FormItem>
        <Button
          icon={<MinusCircleOutlined />}
          onClick={() => remove(field.name)}
        />
      </Space.Compact>
    )
  }

  function renderBefore (name) {
    const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
    const { themeConfig } = props
    return (
      <FormItem name={[name, 'color']} noStyle>
        <Select
          onChange={handleTrigger}
        >
          {
            colors.map(color => {
              const ps = {
                className: 'color-picker-choose iblock',
                style: {
                  backgroundColor: themeConfig[color]
                }
              }
              return (
                <OptionSel key={color} value={color}>
                  <span
                    {...ps}
                  />
                </OptionSel>
              )
            })
          }
        </Select>
      </FormItem>
    )
  }

  useEffect(() => {
    formChild.resetFields()
  }, [props.keywordFormReset])

  return (
    <Form
      form={formChild}
      onValuesChange={handleTrigger}
      initialValues={formData}
      onFinish={handleFinish}
    >
      <FormItem {...formItemLayout}>
        <FormList
          name='keywords'
        >
          {
            (fields, { add, remove }, { errors }) => {
              // 全量渲染 (未渲染字段不进 onFinish 会丢数据), 折叠仅裁视觉高度
              const collapsedStyle = expanded
                ? { marginBottom: 8 }
                : { maxHeight: COLLAPSED_MAX_HEIGHT, overflow: 'hidden', marginBottom: 8 }
              return (
                <>
                  <div style={collapsedStyle}>
                    {
                      fields.map((field, i) => {
                        return renderItem(field, i, add, remove)
                      })
                    }
                  </div>
                  <FormItem>
                    <Button
                      type='dashed'
                      onClick={() => {
                        add({
                          color: 'red'
                        })
                        setExpanded(true)
                      }}
                      icon={<PlusOutlined />}
                    >
                      {e('keyword')}
                    </Button>
                    {
                      fields.length > COLLAPSE_THRESHOLD && (
                        <Button
                          type='text'
                          icon={expanded ? <UpOutlined /> : <DownOutlined />}
                          onClick={() => setExpanded(!expanded)}
                        >
                          {
                            expanded
                              ? e('collapseAll')
                              : `${e('expandAll')} (${fields.length})`
                          }
                        </Button>
                      )
                    }
                  </FormItem>
                </>
              )
            }
          }
        </FormList>
      </FormItem>
    </Form>
  )
}
