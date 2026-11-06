// 数据库连接书签表单配置（阶段1 MVP：mysql/redis）
import { formItemLayout } from '../../../common/form-layout.js'
import {
  terminalDatabaseType,
  newBookmarkIdPrefix,
  dbTypeMap,
  dbTypeLabelMap,
  dbDefaultPortMap,
  dbFileTypes
} from '../../../common/constants.js'
import { createBaseInitValues } from '../common/init-values.js'
import { commonFields } from './common-fields.js'

const e = window.translate

// 网络字段（host/port/账号/库名/隧道/SSL）的可见性：本地文件引擎一个都不需要。
// showWhen 收到的是 antd 的 getFieldValue（见 common/fields.jsx）
const isNet = dbType => !dbFileTypes.has(dbType)
const showWhenNet = (get) => isNet(get('dbType'))
const showWhenFile = (get) => dbFileTypes.has(get('dbType'))

const requiredMsg = (label) => e(label) + ' required'

// N1 校验档位：值域与主进程 src/app/lib/db-client/db-tls.js 的 VERIFY_MODES 一一对应，
// 顺序即下拉顺序（安全的排前面，兜底档在最后并写明风险）。
const sslVerifyOptions = [
  { value: 'system', label: e('dbSslVerifySystem') },
  { value: 'ca', label: e('dbSslVerifyCa') },
  { value: 'none', label: e('dbSslVerifyNone') }
]

const databaseConfig = {
  key: 'database',
  type: terminalDatabaseType,
  initValues: (props) => {
    // 新建 vs 已有：已有书签**没有** dbSslVerify 字段时，不能让默认值落到它身上。
    // createBaseInitValues 是 { ...defaults, ...formData }，缺键的旧书签会拿到 defaults
    // 的值 —— 若默认 'system'，用户只是打开看一眼再保存，原来能连的自签内网盘
    // 下次连接就变成"证书校验失败"，且没人会怀疑到一次打开表单。
    // 所以：新书签默认安全档（system），旧书签按 B1 原行为冻结为 none。
    const id = (props.formData && props.formData.id) || ''
    const isNew = id.startsWith(newBookmarkIdPrefix)
    return createBaseInitValues(props, terminalDatabaseType, {
      dbType: dbTypeMap.mysql,
      dbHost: '127.0.0.1',
      dbPort: dbDefaultPortMap.mysql,
      dbUser: 'root',
      dbPassword: '',
      dbName: '',
      // H8a：本地文件引擎（sqlite）的库文件绝对路径；其余引擎忽略此字段
      dbFile: '',
      sshTunnelBookmarkId: '',
      // 默认只读：主进程按此开关执行 SELECT/SHOW/DESC/EXPLAIN 白名单（见 db-client）
      readOnly: true,
      // E1 连接级安全带：默认非生产，非生产走两级确认（write 首次 / ddl、dangerous 每次）
      production: false,
      // B1：TLS/SSL 连接开关，默认关闭（内部自签场景再开启）
      dbSsl: false,
      // N1：证书校验档位（仅 dbSsl 开启时有意义）
      dbSslVerify: isNew ? 'system' : 'none',
      dbSslCa: ''
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
        {
          type: 'dbFilePicker',
          name: 'dbFile',
          label: () => e('dbFile'),
          showWhen: showWhenFile,
          rules: [{ required: true, message: requiredMsg('dbFile') }]
        },
        {
          // 本地文件的后果要先说清：应用只是打开这个文件，不存在会直接报错、
          // 不会替用户建库（建库请去 SQL 工具页执行 CREATE TABLE）
          type: 'info',
          name: 'dbFileHint',
          showWhen: showWhenFile,
          props: {
            message: e('dbFileHint')
          }
        },
        { type: 'input', name: 'dbHost', label: () => e('host'), showWhen: showWhenNet, rules: [{ required: true, message: requiredMsg('host') }] },
        { type: 'number', name: 'dbPort', label: () => e('port'), showWhen: showWhenNet, rules: [{ required: true, message: 'port required' }] },
        { type: 'input', name: 'dbUser', label: () => e('username'), showWhen: showWhenNet },
        { type: 'password', name: 'dbPassword', label: () => e('password'), showWhen: showWhenNet },
        { type: 'input', name: 'dbName', label: () => e('dbName'), showWhen: showWhenNet },
        { type: 'dbTunnelSelect', name: 'sshTunnelBookmarkId', label: '', showWhen: showWhenNet },
        {
          type: 'switch',
          name: 'readOnly',
          label: () => e('readOnly'),
          valuePropName: 'checked'
        },
        {
          // B1：SSL/TLS 连接开关。N1 起它只决定"加不加加密"，
          // 证书是否校验由下面的档位决定（旧版本写死不校验=对中间人不设防）
          type: 'switch',
          name: 'dbSsl',
          label: () => e('dbUseSsl'),
          showWhen: showWhenNet,
          valuePropName: 'checked'
        },
        {
          // N1：证书校验档位。
          // 不按 dbSsl 开关联动显隐：showWhen 的重渲染只比较 dbType（见 common/fields.jsx
          // 的 shouldUpdate），挂在 dbSsl 上会出现"开关已开但档位不出现"的假象。
          // 常显的代价只是多两行，而漏一行会让人以为自己在校验。
          type: 'select',
          name: 'dbSslVerify',
          label: () => e('dbSslVerifyLabel'),
          showWhen: showWhenNet,
          options: sslVerifyOptions
        },
        {
          // N1：CA 档位的证书文件。路径必须手填得动（容器里挂的证书、网络路径），
          // 所以复用 dbFilePicker 那套"输入框 + 原生选择器 + 失焦归一"，只换 filters 与文案
          type: 'dbCaFilePicker',
          name: 'dbSslCa',
          label: () => e('dbSslCaFile'),
          showWhen: showWhenNet,
          placeholder: 'dbSslCaPlaceholder',
          // 只在"选了 CA 档位"时要求非空：校验发生在提交时、读的是当前表单值，
          // 不依赖重渲染，因此比 showWhen 可靠（主进程那边同样会拒绝空 CA）
          rules: [({ getFieldValue }) => ({
            validator: (_, value) => {
              const need = getFieldValue('dbSsl') &&
                getFieldValue('dbSslVerify') === 'ca' &&
                !String(value || '').trim()
              return need
                ? Promise.reject(new Error(requiredMsg('dbSslCaFile')))
                : Promise.resolve()
            }
          })]
        },
        {
          // 风险必须写在界面上：'none' 是旧书签的兼容档，但它等于对中间人不设防，
          // 用户不知道该档位只在校验档缺失时才该选
          type: 'info',
          name: 'dbSslVerifyHint',
          showWhen: showWhenNet,
          props: {
            message: e('dbSslVerifyHint'),
            showIcon: true
          }
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
