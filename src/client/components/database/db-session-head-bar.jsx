/**
 * 数据库页顶部工具条（N11a #16 布局骨架：从 db-session.jsx 的 headBar 逐字搬出）。
 *
 * 为什么单独成文件：这是页面 chrome（引擎/目标/连接状态 + 风险组 + 系统库组 +
 * 窗口级动作），与数据库页的会话状态、数据网格、SQL 编辑器都没有共享结构，
 * 却独占着 owner 渲染段里最"长得像另一个页面"的一块。搬出来后 owner 只留一行
 * 挂载，改顶栏交互不必再在六千行的会话组件里翻找。
 *
 * 纯展示：所有状态与回调由 owner 注入，本文件不持有任何 state。
 */
import { Button, Switch, Tooltip } from 'antd'
import { InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { dbTypeLabelMap } from '../../common/constants'
import { readOnlyHintKey } from '../../common/db-safe-guard'
import SearchBar from '../common/search-bar'
import SessionBarActions from '../common/session-bar-actions'

const e = window.translate

export default function DbSessionHeadBar ({
  tab,
  target,
  connError,
  isProduction,
  isReadonly,
  bypassMinutes,
  toggleProductionBypass,
  toggleReadonly,
  hideSystemSchemas,
  toggleSys,
  isRedis,
  redisInfo,
  openRedisInfo,
  reconnect,
  treeLoading,
  loadTree,
  searchOpen,
  setSearchOpen,
  closeSearch,
  searchText,
  setSearchText,
  goHit,
  searchIndex,
  searchHits
}) {
  return (
    <div className='db-head'>
      <span className='db-head-engine'>{dbTypeLabelMap[tab.dbType] || tab.dbType}</span>
      <span className='db-head-target elli' title={target}>{target}</span>
      <span className='db-head-state'>
        <i className={`db-head-dot ${connError ? 'err' : 'ok'}`} />
        {connError ? e('disconnected') : e('connected')}
      </span>
      <span className='db-head-right'>
        {/* U1：右侧按语义分三组，组间 1px 分隔线 —— 与左侧"引擎/目标/状态"的
            连接信息分开，风险开关不再和刷新按钮混成一排 */}
        <span className='db-tool-group'>
          {
            // E1 生产连接常驻标记：顶部工具条是唯一跨 tab（数据/SQL/结构）都可见的位置，
            // 徽标放这里才算"常驻提醒"；临时解除生效期间按钮显示剩余分钟
            isProduction
              ? (
                <Tooltip title={e('dbProductionHint')}>
                  <span className='db-prod-flag'>{e('dbRiskProduction')}</span>
                </Tooltip>
                )
              : null
          }
          {
            isProduction
              ? (
                // 只读模式下这个按钮必须禁用：写操作本来就由主进程截断，
                // 允许"临时解除 5 分钟"是纯误导 —— 用户点完以为放开了，实际什么都没变，
                // 下次仍然被拦，于是连这个开关也不再被相信。
                // Tooltip 挂在 span 上而不是 Button 上：disabled 的按钮不派发鼠标事件，
                // 挂在按钮自己的 Tooltip 永远不触发（antd 的已知行为）。
                <Tooltip title={isReadonly ? e('dbRiskBypassReadonly') : ''}>
                  <span className='db-prod-bypass-wrap'>
                    <Button
                      className={'db-prod-bypass' + (bypassMinutes > 0 ? ' is-on' : '')}
                      size='small'
                      disabled={isReadonly}
                      onClick={toggleProductionBypass}
                    >
                      {
                        bypassMinutes > 0
                          ? e('dbRiskBypassLeft').replace('{n}', String(bypassMinutes))
                          : e('dbRiskBypass')
                      }
                    </Button>
                  </span>
                </Tooltip>
                )
              : null
          }
          {/* 只读开关常驻工具条：切换后主进程白名单同步生效（不用重开连接）。
              它与生产标记同属"风险"组：一个说连接本身危险，一个说当前是否允许写。
              文案与"系统库"同一个位置同一个样式，两个开关并排时不靠 tooltip 才分得清 */}
          <Tooltip title={`${e('readOnly')} — ${e(readOnlyHintKey(tab.dbType))}`}>
            <span className='db-sys-toggle'>
              <span className='db-tool-label'>{e('readOnly')}</span>
              <Switch
                size='small'
                checked={isReadonly}
                onChange={toggleReadonly}
                aria-label={e('readOnly')}
              />
            </span>
          </Tooltip>
        </span>
        <span className='db-tool-sep' />
        {/* 系统库显示开关：默认显示，关闭即隐藏 information_schema 等（偏好持久化 config） */}
        <span className='db-tool-group'>
          <Tooltip title={`${e('systemSchemas')} — ${e('systemSchemasHint')}`}>
            <span className='db-sys-toggle'>
              <span className='db-tool-label'>{e('systemSchemas')}</span>
              <Switch
                size='small'
                checked={!hideSystemSchemas}
                onChange={toggleSys}
                aria-label={e('systemSchemas')}
              />
            </span>
          </Tooltip>
        </span>
        <span className='db-tool-sep' />
        <span className='db-tool-group'>
          {
            // H7a-4：Redis 独有入口，放顶栏而不是 Redis 工具条：弹层是"这个实例怎么样"，
            // 与当前在看的键无关，且顶栏是唯一跨 tab 都可见的位置
            isRedis
              ? (
                <Button
                  size='small'
                  icon={<InfoCircleOutlined />}
                  loading={redisInfo.loading && redisInfo.open}
                  onClick={openRedisInfo}
                >
                  {e('dbRedisInfo')}
                </Button>
                )
              : null
          }
          {
            connError
              ? (
                <Button
                  size='small'
                  icon={<ReloadOutlined />}
                  onClick={reconnect}
                >
                  {e('reconnect')}
                </Button>
                )
              : null
          }
          <Button
            type='text'
            size='small'
            icon={<ReloadOutlined />}
            loading={treeLoading}
            title={e('refresh')}
            aria-label={e('refresh')}
            onClick={() => loadTree()}
          />
        </span>
      </span>
      {/* 窗口级动作：与终端顶栏（SessionControl 右侧）同口径——查找 + 全屏入口在这里，
          退出全屏由页面内浮层 RemoteFloatControl 提供 */}
      <span className='db-head-actions'>
        {
          searchOpen
            ? (
              // 统一查找条（common/search-bar）：计数 (i/n) + 上一个/下一个 + 关闭
              <SearchBar
                value={searchText}
                onChange={ev => setSearchText(ev.target.value)}
                onClose={closeSearch}
                onPrev={() => goHit(-1)}
                onNext={() => goHit(1)}
                matchIndex={searchIndex}
                matchCount={searchHits}
                placeholder={e('search')}
              />
              )
            : null
        }
        {/* S1：查找/全屏走共享动作组件，与终端顶栏同位置同口径 */}
        <SessionBarActions
          searchOpen={searchOpen}
          onToggleSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          onFullscreen={() => window.store.toggleSessFullscreen(true)}
        />
      </span>
    </div>
  )
}
