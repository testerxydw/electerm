// 数据库连接书签表单配置（阶段1 MVP：mysql/redis）
import { formItemLayout } from '../../../common/form-layout.js'
import {
  terminalDatabaseType,
  dbTypeMap,
  dbTypeLabelMap,
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
      sshTunnelBookmarkId: '',
      // 默认只读：主进程按此开关执行 SELECT/SHOW/DESC/EXPLAIN 白名单（见 db-client）
      readOnly: true,
      // E1 连接级安全带：默认非生产，非生产走两级确认（write 首次 / ddl、dangerous 每次）
      production: false,
      // B1：TLS/SSL 连接开关，默认关闭（内部自签场景再开启）
      dbSsl: false
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
          // dbTypeSelect：切换引擎时联动默认端口（见 fields.jsx）
          type: 'dbTypeSelect',
          name: 'dbType',
          label: () => e('dbType'),
          // 显示名统一取自 dbTypeLabelMap（与 tab 标题前缀同源），新增引擎不必改多处
          options: Object.keys(dbTypeMap).map(k => ({
            label: dbTypeLabelMap[k],
            value: dbTypeMap[k]
          }))
        },
        { type: 'input', name: 'dbHost', label: () => e('host'), rules: [{ required: true, message: e('host') + ' required' }] },
        { type: 'number', name: 'dbPort', label: () => e('port'), rules: [{ required: true, message: 'port required' }] },
        { type: 'input', name: 'dbUser', label: () => e('username') },
        { type: 'password', name: 'dbPassword', label: () => e('password') },
        { type: 'input', name: 'dbName', label: () => e('dbName') },
        { type: 'dbTunnelSelect', name: 'sshTunnelBookmarkId', label: '' },
        {
          type: 'switch',
          name: 'readOnly',
          label: () => e('readOnly'),
          valuePropName: 'checked'
        },
        {
          // B1：SSL/TLS 连接开关（覆盖内部自签场景，采用 rejectUnauthorized: false）
          type: 'switch',
          name: 'dbSsl',
          label: () => e('dbUseSsl'),
          valuePropName: 'checked'
        },
        {
          // E1 连接级安全带：danger 检查挂在连接上才能持续（每次弹窗会被点麻）。
          // 默认关闭；开启后所有非查询语句都要二次确认并输入库名
          type: 'switch',
          name: 'production',
          label: () => e('dbProductionFlag'),
          valuePropName: 'checked'
        },
        {
          // 说明文案单独一行（Alert）：Switch 的 label 只有一行空间，
          // 而"要输库名"这个后果必须写清楚，否则用户不知道勾了什么
          type: 'info',
          name: 'productionHint',
          props: {
            message: e('dbProductionHint'),
            showIcon: true
          }
        },
        commonFields.description,
        commonFields.type
      ]
    }
  ]
}

export default databaseConfig
