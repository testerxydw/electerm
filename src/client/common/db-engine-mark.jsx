/**
 * 数据库会话/书签的引擎标识：统一圆柱图形 + 引擎色（--db-engine-* token）
 * 书签树与 tab 页签共用同一标识语言：
 *   · isDbSession  —— 类型守卫（type === database）
 *   · DbEngineMark —— 13px 圆柱线稿，色随引擎 token
 *   · DbEngineBadge —— 引擎名文字徽标，色随引擎 token；
 *     形态（描边/淡底、间距、让位）由调用方 styl 决定
 */
import { terminalDatabaseType } from './constants'

function engineColor (dbType) {
  return 'var(--db-engine-' + (dbType || 'mysql') + ')'
}

export function isDbSession (item) {
  return Boolean(item && item.type === terminalDatabaseType)
}

export function DbEngineMark ({ dbType }) {
  return (
    <span
      className='db-engine-mark'
      style={{ color: engineColor(dbType) }}
    >
      <svg
        viewBox='0 0 24 24'
        width='13'
        height='13'
        fill='none'
        stroke='currentColor'
        strokeWidth='2.2'
      >
        <ellipse cx='12' cy='5' rx='8' ry='3' />
        <path d='M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5' />
        <path d='M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' />
      </svg>
    </span>
  )
}

export function DbEngineBadge ({ dbType, className = '' }) {
  const t = dbType || 'mysql'
  return (
    <span
      className={('db-engine-badge ' + className).trim()}
      style={{
        color: engineColor(t),
        fontSize: '10px',
        lineHeight: '15px',
        padding: '0 5px',
        borderRadius: 'var(--radius-pill)'
      }}
    >
      {t}
    </span>
  )
}
