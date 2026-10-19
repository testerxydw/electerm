/**
 * 终端查找条（SSH/终端页顶栏内联展开，由 SessionControl 挂载；原右上浮层已废弃）。
 * UI 骨架来自 common/search-bar；引擎 = xterm SearchAddon（findNext/findPrevious）。
 * 大小写/整词/正则开关作为 SearchBar 的 suffix 插槽。
 */
import { useEffect } from 'react'
import { auto } from 'manate/react'
import { Tooltip } from 'antd'
import SearchBar from '../common/search-bar'
import { paneMap } from '../../common/constants'
import { MatchCaseIcon } from '../icons/match-case'
import { MatchWholWordIcon } from '../icons/match-whole-word'
import { RegularExpIcon } from '../icons/regular-exp'
import classNames from 'classnames'
import copy from 'json-deep-copy'
import { refsStatic, refs } from '../common/ref'
import './term-search.styl'

const e = window.translate

// 清空 xterm 搜索装饰与结果态
function clearSearch () {
  const term = refs.get('term-' + window.store.activeTabId)
  if (term) {
    term.searchAddon.clearDecorations()
    term.setState({
      searchResults: [],
      matchIndex: -1
    })
  }
}

// 注册到 refsStatic['term-search']：供快捷键（shortcut-control）与终端右键
// 菜单（term-context-menu）调用 toggleSearch/next。全部由 store 驱动，无实例态。
const controller = {
  toggleSearch () {
    const isClosing = window.store.termSearchOpen
    if (isClosing) {
      clearSearch()
    }
    window.store.toggleTerminalSearch()
    if (isClosing) {
      setTimeout(window.store.focus, 200)
    }
  },
  prev (searchTerm) {
    refs.get('term-' + window.store.activeTabId)
      ?.searchPrev(
        typeof searchTerm === 'string' ? searchTerm : window.store.termSearch,
        copy(window.store.termSearchOptions)
      )
  },
  next () {
    refs.get('term-' + window.store.activeTabId)
      ?.searchNext(
        window.store.termSearch,
        copy(window.store.termSearchOptions)
      )
  }
}

const searchControls = [{
  id: 'matchCase',
  icon: MatchCaseIcon,
  prop: 'caseSensitive'
}, {
  id: 'matchWholeWord',
  icon: MatchWholWordIcon,
  prop: 'wholeWord'
}, {
  id: 'useRegExp',
  icon: RegularExpIcon,
  prop: 'regex'
}]

function TermSearch (props) {
  const { tab } = props
  useEffect(() => {
    refsStatic.add('term-search', controller)
    return () => refsStatic.remove('term-search')
  }, [])
  const {
    termSearchOpen,
    termSearch,
    termSearchOptions,
    termSearchMatchCount,
    termSearchMatchIndex
  } = window.store
  if (
    !termSearchOpen ||
    !tab ||
    tab.pane === paneMap.fileManager
  ) {
    return null
  }

  // 大小写/整词/正则开关：切换后立即按新选项重查
  function renderSearchControl (item) {
    const { id, icon: Icon, prop } = item
    const v = termSearchOptions[prop]
    const cls = classNames('term-search-opt-icon', {
      'term-search-on': v
    })
    return (
      <Tooltip
        key={id}
        title={e(id)}
      >
        <Icon
          className={cls}
          onClick={() => {
            window.store.setTermSearchOption({
              [prop]: !v
            })
            controller.next()
          }}
        />
      </Tooltip>
    )
  }

  function handleChange (ev) {
    const v = ev.target.value
    window.store.termSearch = v
    if (v) {
      controller.prev(v)
    } else {
      clearSearch()
    }
  }

  function close () {
    clearSearch()
    window.store.termSearchOpen = false
  }

  return (
    <div className='term-search-wrap'>
      <SearchBar
        value={termSearch}
        onChange={handleChange}
        onClose={close}
        onPrev={() => controller.prev()}
        onNext={() => controller.next()}
        matchIndex={termSearchMatchIndex}
        matchCount={termSearchMatchCount}
        placeholder={e('search')}
        suffix={searchControls.map(renderSearchControl)}
      />
    </div>
  )
}

export default auto(TermSearch)
