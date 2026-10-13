/**
 * customizable icons for the far-left sidebar.
 *
 * `text` is a locale key passed to window.translate. The "about",
 * "hide sidebar" and "file transfer" icons are intentionally excluded —
 * they are always visible / conditionally rendered and not part of the
 * customizable set.
 *
 * order of `leftSidebarIconOptions` is the default order shown in the sidebar.
 */
export const leftSidebarIconOptions = [
  { id: 'newBookmark', text: 'newBookmark' },
  { id: 'quickConnect', text: 'quickConnect' },
  { id: 'bookmarks', text: 'bookmarks' },
  { id: 'terminalThemes', text: 'terminalThemes' },
  { id: 'setting', text: 'setting' },
  { id: 'settingSync', text: 'settingSync' },
  { id: 'widgets', text: 'widgets' }
]

// default ordered list of icon ids — mirrors the order above
export const defaultLeftSideBarIcons = leftSidebarIconOptions.map(o => o.id)

// 旧版默认列表（新增右面板页签入口前的 7 项）：
// 存量用户 DB 里的 config.leftSideBarIcons 持久化的正是这份值，
// 迁移时据此判定"从未自定义过图标"并升级到新默认，自定义过的配置不动
export const legacyDefaultLeftSideBarIcons = [
  'newBookmark',
  'quickConnect',
  'bookmarks',
  'terminalThemes',
  'setting',
  'settingSync',
  'widgets'
]

// valid ids, for sanitizing persisted/synced config
export const leftSidebarIconIds = new Set(leftSidebarIconOptions.map(o => o.id))

/**
 * returns a clean, ordered list of icon ids from a possibly-untrusted value:
 * unknown ids dropped, missing default ids left to the user's choice.
 */
export function normalizeLeftSideBarIcons (value) {
  if (!Array.isArray(value)) {
    return [...defaultLeftSideBarIcons]
  }
  const filtered = value.filter(id => leftSidebarIconIds.has(id))
  // 从未自定义过（恰为旧默认列表）的存量配置升级到新默认；
  // 用户自定义过的列表（增删过任意项）保持原样，缺失项视为有意移除
  if (
    filtered.length === legacyDefaultLeftSideBarIcons.length &&
    legacyDefaultLeftSideBarIcons.every((id, i) => filtered[i] === id)
  ) {
    return [...defaultLeftSideBarIcons]
  }
  return filtered
}
