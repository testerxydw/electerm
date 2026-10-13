// 数据库连接书签表单配置（阶段1 MVP：mysql/redis）
import { formItemLayout } from '../../../common/form-layout.js'
import {
  terminalDatabaseType,
  dbTypeMap,
  dbDefaultPortMap
} from '../../../common/constants.js'
import { createBaseInitValues } from '../common/init-values.js'
import { commonFields } from './common-fields.js'

const e = window.translate

const databaseConfig = {
  key: 'database',
  type: terminalDatabaseType,
  initValues: (props) => {
    return createBaseInitValues(props, terminalDatabaseType, {
      dbType: dbTypeMap.mysql,
      dbHost: '127.0.0.1',
      dbPort: dbDefaultPortMap.mysql,
      dbUser: 'root',
      dbPassword: '',
      dbName: '',
      sshTunnelBookmarkId: ''
    })
  },
  layout: formItemLayout,
  tabs: () => [
    {
      key: 'auth',
      label: e('auth'),
      fields: [
        commonFields.category,
        commonFields.colorTitle,
        {
          type: 'select',
          name: 'dbType',
          label: () => e('dbType'),
          options: [
            { label: 'MySQL', value: dbTypeMap.mysql },
            { label: 'Redis', value: dbTypeMap.redis },
            { label: 'PostgreSQL', value: dbTypeMap.postgres },
            { label: 'TiDB', value: dbTypeMap.tidb },
            { label: 'OceanBase', value: dbTypeMap.oceanbase }
          ]
        },
        { type: 'input', name: 'dbHost', label: () => e('host'), rules: [{ required: true, message: e('host') + ' required' }] },
        { type: 'number', name: 'dbPort', label: () => e('port'), rules: [{ required: true, message: 'port required' }] },
        { type: 'input', name: 'dbUser', label: () => e('username') },
        { type: 'password', name: 'dbPassword', label: () => e('password') },
        { type: 'input', name: 'dbName', label: () => e('database') },
        { type: 'dbTunnelSelect', name: 'sshTunnelBookmarkId', label: '' },
        commonFields.description,
        commonFields.type
      ]
    }
  ]
}

export default databaseConfig
