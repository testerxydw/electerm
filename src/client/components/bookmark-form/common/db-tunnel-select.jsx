/**
 * ssh tunnel bookmark selector for database bookmarks
 * lists existing ssh bookmarks, empty means direct connection
 */

import { Select, Form } from 'antd'
import { formItemLayout } from '../../../common/form-layout'

const FormItem = Form.Item
const e = window.translate

export default function DbTunnelSelect ({
  bookmarks = []
}) {
  const options = (bookmarks || [])
    .filter(d => d.type === 'ssh')
    .map(d => {
      const title = d.title || d.host
      return {
        label: `${title} (${d.host})`,
        value: d.id
      }
    })
  return (
    <FormItem
      {...formItemLayout}
      label={e('sshTunnel')}
    >
      <FormItem noStyle name='sshTunnelBookmarkId'>
        <Select
          allowClear
          showSearch
          optionFilterProp='label'
          placeholder={e('sshTunnel')}
          options={options}
        />
      </FormItem>
    </FormItem>
  )
}
