/**
 * extend store
 */

import { refs } from '../components/common/ref'

export default Store => {
  Store.prototype.focus = function () {
    window.focused = true
    refs.get('term-' + window.store.activeTabId)?.term?.focus()
  }

  Store.prototype.blur = function () {
    window.focused = false
    refs.get('term-' + window.store.activeTabId)?.term?.blur()
  }

  Store.prototype.onBlur = function () {
    window.focused = false
  }

  Store.prototype.selectall = function () {
    document.activeElement &&
    document.activeElement.select &&
    document.activeElement.select()
    refs.get('term-' + window.store.activeTabId)?.term?.selectAll()
  }

  Store.prototype.toggleSessFullscreen = function (fullscreen) {
    window.store.fullscreen = fullscreen
  }
}
