/**
 * Field renderers for config-driven forms
 * Maps field types to React components
 */
import React from 'react'
import { Form, Input, InputNumber, Select, AutoComplete, Alert, Radio } from 'antd'
import { ColorPickerItem } from './color-picker-item.jsx'
import Password from '../../common/password.jsx'
import SwitchLabel from '../../common/switch.jsx'
import InputAutoFocus from '../../common/input-auto-focus.jsx'
import ProxyField from './proxy.jsx'
import X11Field from './x11.jsx'
import SshTunnels from './ssh-tunnels.jsx'
import SshAgent from './ssh-agent.jsx'
import ConnectionHopping from './connection-hopping.jsx'
import TerminalBackgroundField from './terminal-background.jsx'
import ExecSettingsField from './exec-settings-field.jsx'
import useQuickCmds from './quick-commands.jsx'
import TriggersField from '../../triggers/triggers-field.jsx'
import ProfileItem from './profile-item.jsx'
import renderRunScripts from './run-scripts.jsx'
import SerialPathSelector from './serial-path-selector.jsx'
import DbTunnelSelect from './db-tunnel-select.jsx'
import DbFileField from './db-file-field.jsx'
import VvFileField from './vv-file-field.jsx'
import HostCheck from './host-check.jsx'
import SshHostSelector from './ssh-host-selector.jsx'
import SshAuthTypeSelector from './ssh-auth-type-selector.jsx'
import SshAuthSelector from './ssh-auth-selector.jsx'
import CategorySelect from './category-select.jsx'
import ExternalLink from '../../common/external-link.jsx'
import { dbDefaultPortMap, dbFileTypes } from '../../../common/constants.js'
import { caFileDialogOptions } from '../../../common/db-file.js'
const Fragment = React.Fragment
const FormItem = Form.Item

const { TextArea } = Input
const commonRenderTypes = new Set([
  'input',
  'textarea',
  'number',
  'switch',
  'select',
  'autocomplete',
  'radio',
  'colorTitle',
  'password',
  'dbTypeSelect'
])

/**
 * Render a single form item based on config
 * @param {Object} item - Field configuration with type, name, label, rules, etc.
 * @param {Object} formItemLayout - Ant Design form layout
 * @param {Object} form - Ant Design form instance
 * @param {Object} ctxProps - Context props (bookmarkGroups, formData, etc.)
 * @param {number} index - Index for key generation
 * @returns {JSX.Element|null} Rendered form item
 */
export function renderFormItem (item, formItemLayout, form, ctxProps, index) {
  const { type, name, label, rules, valuePropName, hidden, normalize, showWhen } = item

  // 按当前表单值显隐（H8a：SQLite 只需要文件路径，host/port/账号/SSL/隧道全部无关）。
  // 用 shouldUpdate 重渲染而不是 className='hide'：隐藏字段的 required 规则必须一起
  // 撤掉，否则切到本地文件引擎后表单永远提交不了
  if (typeof showWhen === 'function') {
    return (
      <FormItem
        key={name}
        noStyle
        shouldUpdate={(prev, cur) => prev.dbType !== cur.dbType}
      >
        {({ getFieldValue }) => (
          showWhen(getFieldValue)
            ? renderFormItem(
              { ...item, showWhen: undefined },
              formItemLayout,
              form,
              ctxProps,
              index
            )
            : null
        )}
      </FormItem>
    )
  }

  // Render simple AntD controls directly inside Form.Item
  if (commonRenderTypes.has(type)) {
    const cls = hidden ? 'hide' : undefined
    let control = null
    switch (type) {
      case 'input':
        control = <Input {...item.props} />
        break
      case 'textarea':
        control = <TextArea autoSize={{ minRows: 1 }} {...item.props} />
        break
      case 'number':
        control = <InputNumber min={1} max={65535} step={1} {...item.props} />
        break
      case 'switch':
        control = <SwitchLabel {...item.props} />
        break
      case 'select':
        control = <Select options={item.options} {...item.props} />
        break
      case 'dbTypeSelect':
        // 数据库引擎选择：切换引擎时联动该引擎的默认端口
        control = (
          <Select
            options={item.options}
            {...item.props}
            onChange={(val, opt) => {
              // 本地文件引擎（sqlite）没有端口概念：切换时不去写 dbPort，也**不主动清**——
              // 用户手滑切走引擎再切回来，不该丢掉自己填的自定义端口。
              // 残留值不影响呈现：页签/错误卡片/工具条的连接目标一律按引擎判，见 dbConnTarget
              if (!dbFileTypes.has(val)) {
                // 仅当端口为空、或仍是某个引擎的默认端口时才覆盖，
                // 避免抹掉用户手工填写的自定义端口
                const cur = form.getFieldValue('dbPort')
                const known = Object.values(dbDefaultPortMap)
                if (
                  cur === undefined ||
                  cur === null ||
                  cur === '' ||
                  known.includes(Number(cur))
                ) {
                  form.setFieldsValue({ dbPort: dbDefaultPortMap[val] })
                }
              }
              if (item.props && item.props.onChange) {
                item.props.onChange(val, opt)
              }
            }}
          />
        )
        break
      case 'autocomplete':
        control = <AutoComplete options={item.options} {...item.props} />
        break
      case 'radio':
        control = (
          <Radio.Group
            options={item.options}
            optionType='button'
            buttonStyle='solid'
            size='small'
            {...item.props}
          />
        )
        break
      case 'colorTitle':
        control = <InputAutoFocus prefix={<ColorPickerItem />} {...item.props} />
        break
      case 'password':
        control = <Password {...item.props} />
        break
      default:
        control = null
    }
    if (!control) return null
    const formItemProps = {
      ...formItemLayout,
      className: cls,
      label: typeof label === 'string' ? label : label(),
      name,
      rules,
      valuePropName,
      normalize
    }
    return (
      <FormItem
        key={name}
        {...formItemProps}
      >
        {control}
      </FormItem>
    )
  }

  // Render complex/custom components directly (no extra wrapper component)
  switch (type) {
    case 'wiki':
      return (
        <Alert
          key={name}
          type='warning'
          className='mg2b'
          showIcon
          description={
            <>
              <ExternalLink to={item.link}>{item.link}</ExternalLink>
            </>
          }
        />
      )
    case 'alert':
      return <Alert key={name} {...item.props} />
    case 'info':
      return <Alert key={name} type='info' {...item.props} />
    case 'warning':
      return <Alert key={name} type='warning' {...item.props} />
    case 'categorySelect':
      return (
        <CategorySelect
          key={name}
          bookmarkGroups={ctxProps.bookmarkGroups || []}
          form={ctxProps.form}
          name={item.name}
          formData={ctxProps.formData}
        />
      )
    case 'proxy':
      return <ProxyField key={name} bookmarks={ctxProps.bookmarks} />
    case 'vvFile':
      return <VvFileField key={name} form={form} />
    case 'hostCheck':
      return <HostCheck key={name} form={form} />
    case 'x11':
      return <X11Field key={name} form={form} />
    case 'sshTunnels':
      return <SshTunnels key={name} form={form} formData={ctxProps.formData} />
    case 'sshAgent':
      return <SshAgent key={name} />
    case 'connectionHopping':
      return (
        <ConnectionHopping
          key={name}
          form={form}
          formData={ctxProps.formData || {}}
          trim={ctxProps.trim}
          store={ctxProps.store}
        />
      )
    case 'terminalBackground':
      return <TerminalBackgroundField key={name} />
    case 'execSettings':
      return <ExecSettingsField key={name} />
    case 'profileItem':
      return <ProfileItem key={name} store={ctxProps.store} form={form} profileFilter={item.profileFilter} />
    case 'quickCommands':
      return <Fragment key={name}>{useQuickCmds(form, ctxProps.formData || {})}</Fragment>
    case 'triggers':
      return <TriggersField key={name} />
    case 'runScripts':
      return <Fragment key={name}>{renderRunScripts()}</Fragment>
    case 'serialPathSelector':
      return (
        <SerialPathSelector
          key={name}
          serials={ctxProps.serials}
          loaddingSerials={ctxProps.loaddingSerials}
          store={ctxProps.store}
          {...item.props}
        />
      )
    case 'dbTunnelSelect':
      return (
        <DbTunnelSelect
          key={name}
          bookmarks={ctxProps.bookmarks}
        />
      )
    case 'dbFilePicker':
      return (
        <DbFileField
          key={name}
          form={form}
          layout={formItemLayout}
          label={typeof label === 'string' ? label : label()}
          name={name}
          rules={rules}
        />
      )
    case 'dbCaFilePicker':
      // N1：TLS CA 证书路径 —— 与库文件同一个组件，只换对话框 filters 与文案
      return (
        <DbFileField
          key={name}
          form={form}
          layout={formItemLayout}
          label={typeof label === 'string' ? label : label()}
          name={name}
          rules={rules}
          dialogOptions={caFileDialogOptions}
          placeholder={item.placeholder}
        />
      )
    case 'sshHostSelector':
      return (
        <SshHostSelector
          key={name}
          ips={ctxProps.ips || []}
          useIp={ctxProps.useIp}
          form={ctxProps.form}
          onBlur={ctxProps.handleBlur}
          onPaste={ctxProps.handlePaste}
          trim={ctxProps.trim}
          {...item.props}
        />
      )
    case 'sshAuthTypeSelector':
      return (
        <SshAuthTypeSelector
          key={name}
          authType={ctxProps.authType}
          handleChangeAuthType={ctxProps.onChangeAuthType}
          {...item.props}
        />
      )
    case 'sshAuthSelector':
      return (
        <SshAuthSelector
          key={name}
          store={ctxProps.store}
          form={form}
          authType={ctxProps.authType}
          profileFilter={item.profileFilter}
          {...item.props}
        />
      )
    default:
      console.warn(`Unknown field type: ${type}`)
      return null
  }
}
