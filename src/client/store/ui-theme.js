/**
 * ui theme functions
 */

import {
  defaultTheme
} from '../common/theme-defaults'

import copy from 'json-deep-copy'

export default Store => {
  Store.prototype.getUiThemeConfig = function () {
    const { store } = window
    // 直接读底层列表与 _config，避免为了找主题而深拷贝整份配置/主题列表
    const themeId = store._config.theme
    const theme = [
      ...store.getTerminalThemes(),
      ...store.itermThemes
    ].find(d => d.id === themeId)
    return theme && theme.uiThemeConfig
      ? copy(theme.uiThemeConfig)
      : defaultTheme().uiThemeConfig
  }
}
