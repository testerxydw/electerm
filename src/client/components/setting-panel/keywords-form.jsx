import {
  Button,
  Input,
  Select,
  Tooltip,
  Popconfirm
} from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined
} from '@ant-design/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import message from '../common/message'
import { keywordPresets } from '../../common/keyword-presets'
import {
  addUserRule,
  allPresetViews,
  isRuleOn,
  presetKeywordIndex,
  removeEntry,
  removeUserGroup,
  renameUserGroup,
  setEntryOn,
  setPresetGroupOn,
  setUserGroupOn,
  updateEntry,
  userGroupViews
} from '../../common/keyword-groups'
import './keywords-form.styl'

const e = window.translate
const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

// antd 的 indeterminate 只能通过 DOM 属性设置
function TriCheck ({ checked, indeterminate, onChange }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = !!indeterminate
    }
  }, [indeterminate])
  return (
    <input
      type='checkbox'
      ref={ref}
      className='kw-check'
      checked={!!checked}
      onChange={ev => onChange(ev.target.checked)}
      onClick={ev => ev.stopPropagation()}
    />
  )
}

function ColorSelect ({ value, onChange, themeConfig }) {
  return (
    <Select
      size='small'
      className='kw-color-select'
      value={value || 'red'}
      onChange={onChange}
      popupMatchSelectWidth={false}
    >
      {
        colors.map(color => (
          <Select.Option key={color} value={color}>
            <span
              className='color-picker-choose iblock'
              style={{ backgroundColor: themeConfig[color] }}
            />
          </Select.Option>
        ))
      }
    </Select>
  )
}

// 单条规则：勾选 = 是否生效；用户规则可改颜色/正则/删除，预设规则只读
function RuleRow (props) {
  const {
    rule, editable, themeConfig, onToggle, onColor, onKeyword, onRemove, dupPreset
  } = props
  const [text, setText] = useState(rule.keyword)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setText(rule.keyword)
    setInvalid(false)
  }, [rule.keyword])

  const check = (value) => {
    try {
      // eslint-disable-next-line no-new
      new RegExp(`(${value})`, 'gi')
      return true
    } catch (err) {
      return false
    }
  }

  const commit = () => {
    if (text === rule.keyword) {
      return
    }
    if (!check(text)) {
      setInvalid(true)
      message.error(e('kwInvalidRegex'))
      return
    }
    setInvalid(false)
    onKeyword(text)
  }

  return (
    <div className={'kw-rule' + (isRuleOn(rule) ? '' : ' off')}>
      <TriCheck
        checked={isRuleOn(rule)}
        onChange={onToggle}
      />
      {
        editable
          ? (
            <ColorSelect
              value={rule.color}
              themeConfig={themeConfig}
              onChange={onColor}
            />
            )
          : (
            <span
              className='kw-swatch'
              style={{ backgroundColor: themeConfig[rule.color] || themeConfig.red }}
            />
            )
      }
      {
        editable
          ? (
            <Input
              size='small'
              className='kw-regex-input'
              status={invalid ? 'error' : ''}
              value={text}
              placeholder={e('keyword')}
              onChange={ev => setText(ev.target.value)}
              onBlur={commit}
              onPressEnter={commit}
            />
            )
          : (
            <code className='kw-regex' title={rule.keyword}>{rule.keyword}</code>
            )
      }
      {
        dupPreset
          ? (
            <Tooltip title={`${e('kwSameAsPreset')}: ${dupPreset}`}>
              <ExclamationCircleOutlined className='kw-dup' />
            </Tooltip>
            )
          : null
      }
      {
        editable
          ? (
            <Button
              size='small'
              type='text'
              danger
              className='kw-rule-del'
              icon={<DeleteOutlined />}
              title={e('kwDeleteRule')}
              onClick={onRemove}
            />
            )
          : null
      }
    </div>
  )
}

export default function KeywordForm (props) {
  const { formData, themeConfig } = props
  const list = formData.keywords || []
  const [q, setQ] = useState('')
  const [onlyOn, setOnlyOn] = useState(false)
  const [openSec, setOpenSec] = useState({ preset: false, user: false })
  const [openGrp, setOpenGrp] = useState({})
  const [renaming, setRenaming] = useState(null)
  const [renameValue, setRenameValue] = useState('')

  const commit = next => props.submit({ keywords: next })
  const presetViews = allPresetViews(list)
  const userGroups = userGroupViews(list)
  const dupIndex = useMemo(presetKeywordIndex, [])
  const filtering = !!q || onlyOn

  const match = (rule) => {
    if (q && !rule.keyword.includes(q)) {
      return false
    }
    if (onlyOn && !isRuleOn(rule)) {
      return false
    }
    return true
  }
  const visibleEntries = entries => entries.filter(({ rule }) => match(rule))

  const appliedPresets = presetViews.filter(v => v.on > 0)
  const presetRuleOn = presetViews.reduce((n, v) => n + v.on, 0)
  const presetRuleTotal = presetViews.reduce((n, v) => n + v.total, 0)
  // 表单里可能有一条尚未填写的空规则（默认行），不计入统计
  const realEntries = entries => entries.filter(({ rule }) => rule.keyword)
  const userRuleOn = userGroups.reduce((n, g) => {
    return n + realEntries(g.entries).filter(({ rule }) => isRuleOn(rule)).length
  }, 0)
  const userRuleTotal = userGroups.reduce((n, g) => n + realEntries(g.entries).length, 0)

  const toggleSec = key => setOpenSec(s => ({ ...s, [key]: !s[key] }))
  const toggleGrp = key => setOpenGrp(s => ({ ...s, [key]: !s[key] }))
  const isOpen = key => filtering || !!openGrp[key]

  const startRename = (name) => {
    setRenaming(name)
    setRenameValue(name)
  }
  const commitRename = () => {
    const from = renaming
    const to = renameValue.trim()
    setRenaming(null)
    if (!to || to === from) {
      return
    }
    if (userGroups.some(g => g.name === to)) {
      message.error(e('kwGroupNameExists'))
      return
    }
    commit(renameUserGroup(list, from, to))
    setOpenGrp(s => ({ ...s, [`u:${to}`]: true }))
  }

  const renderRule = (entry) => {
    const { rule, index } = entry
    return (
      <RuleRow
        key={'r' + index}
        rule={rule}
        editable={rule.source !== 'preset'}
        themeConfig={themeConfig}
        onToggle={on => commit(setEntryOn(list, index, on))}
        onColor={color => commit(updateEntry(list, index, { color }))}
        onKeyword={keyword => commit(updateEntry(list, index, { keyword }))}
        onRemove={() => commit(removeEntry(list, index))}
        dupPreset={rule.source === 'preset' ? null : dupIndex.get(rule.keyword)}
      />
    )
  }

  const renderPresetGroup = (view) => {
    const preset = keywordPresets.find(p => p.name === view.name)
    const key = 'p:' + view.name
    const entries = visibleEntries(view.entries)
    if (filtering && !entries.length) {
      return null
    }
    const expanded = isOpen(key)
    return (
      <div className='kw-group' key={key}>
        <div className='kw-group-head' onClick={() => toggleGrp(key)}>
          <TriCheck
            checked={view.checked}
            indeterminate={view.indeterminate}
            onChange={on => commit(setPresetGroupOn(list, preset, on))}
          />
          <span className={'kw-caret' + (expanded ? ' open' : '')} />
          <span className='kw-group-name'>{view.name}</span>
          <span className='kw-pill'>{view.total}</span>
          <span className='kw-group-desc' title={view.description}>{view.description}</span>
          <span className={'kw-group-count' + (view.on ? ' on' : '')}>
            {e('kwApplied')} {view.on}/{view.total}
          </span>
        </div>
        {
          expanded
            ? <div className='kw-rules'>{entries.map(renderRule)}</div>
            : null
        }
      </div>
    )
  }

  const renderUserGroup = (group) => {
    const key = 'u:' + group.name
    const entries = visibleEntries(group.entries)
    if (filtering && !entries.length) {
      return null
    }
    const expanded = isOpen(key)
    const named = !!group.name
    const real = realEntries(group.entries)
    const realOn = real.filter(({ rule }) => isRuleOn(rule)).length
    return (
      <div className='kw-group' key={key}>
        <div className='kw-group-head' onClick={() => toggleGrp(key)}>
          <TriCheck
            checked={real.length > 0 && realOn === real.length}
            indeterminate={realOn > 0 && realOn < real.length}
            onChange={on => commit(setUserGroupOn(list, group.name, on))}
          />
          <span className={'kw-caret' + (expanded ? ' open' : '')} />
          {
            renaming === group.name
              ? (
                <Input
                  size='small'
                  autoFocus
                  className='kw-group-rename'
                  value={renameValue}
                  onClick={ev => ev.stopPropagation()}
                  onChange={ev => setRenameValue(ev.target.value)}
                  onPressEnter={commitRename}
                  onBlur={commitRename}
                />
                )
              : (
                <span className='kw-group-name'>
                  {named ? group.name : e('kwManualGroup')}
                </span>
                )
          }
          <span className='kw-pill'>{real.length}</span>
          <span className={'kw-group-count' + (realOn ? ' on' : '')}>
            {e('kwApplied')} {realOn}/{real.length}
          </span>
          {
            named
              ? (
                <span className='kw-group-ops'>
                  <Button
                    size='small'
                    type='text'
                    icon={<EditOutlined />}
                    title={e('rename')}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      startRename(group.name)
                    }}
                  />
                  <Popconfirm
                    title={e('kwDeleteGroupConfirm')}
                    okText={e('kwDeleteGroup')}
                    cancelText={e('cancel')}
                    onConfirm={() => commit(removeUserGroup(list, group.name))}
                  >
                    <Button
                      size='small'
                      type='text'
                      danger
                      icon={<DeleteOutlined />}
                      title={e('kwDeleteGroup')}
                      onClick={ev => ev.stopPropagation()}
                    />
                  </Popconfirm>
                </span>
                )
              : null
          }
        </div>
        {
          expanded
            ? (
              <div className='kw-rules'>
                {entries.map(renderRule)}
                {
                  named
                    ? null
                    : (
                      <Button
                        type='dashed'
                        size='small'
                        className='kw-add-rule'
                        icon={<PlusOutlined />}
                        onClick={() => commit(addUserRule(list, { group: '' }))}
                      >
                        {e('keyword')}
                      </Button>
                      )
                }
              </div>
              )
            : null
        }
      </div>
    )
  }

  const setAll = (on) => {
    let next = list
    for (const preset of keywordPresets) {
      next = setPresetGroupOn(next, preset, on)
    }
    for (const g of userGroups) {
      next = setUserGroupOn(next, g.name, on)
    }
    commit(next)
  }

  return (
    <div className='kw-wrap'>
      <div className='kw-toolbar'>
        <Input
          size='small'
          allowClear
          className='kw-search'
          placeholder={e('kwSearchPlaceholder')}
          value={q}
          onChange={ev => setQ(ev.target.value)}
        />
        <Button size='small' onClick={() => setAll(true)}>{e('kwApplyAll')}</Button>
        <Button size='small' onClick={() => setAll(false)}>{e('kwUnapplyAll')}</Button>
        <label className='kw-only-on'>
          <input
            type='checkbox'
            className='kw-check'
            checked={onlyOn}
            onChange={ev => setOnlyOn(ev.target.checked)}
          />
          {e('kwOnlyApplied')}
        </label>
        <span className='kw-stat'>
          {e('kwApplied')} {e('keyword')} {presetRuleOn + userRuleOn}/{presetRuleTotal + userRuleTotal}
        </span>
      </div>

      <div className='kw-section'>
        <div className='kw-sec-head' onClick={() => toggleSec('preset')}>
          <span className={'kw-caret' + (openSec.preset ? ' open' : '')} />
          <span className='kw-sec-title'>{e('kwPresetGroup')}</span>
          <span className='kw-badge'>
            {appliedPresets.length}/{presetViews.length} · {e('keyword')} {presetRuleOn}/{presetRuleTotal}
          </span>
        </div>
        {
          openSec.preset
            ? (
              <div className='kw-sec-body'>
                {presetViews.map(renderPresetGroup)}
              </div>
              )
            : null
        }
      </div>

      <div className='kw-section'>
        <div className='kw-sec-head' onClick={() => toggleSec('user')}>
          <span className={'kw-caret' + (openSec.user ? ' open' : '')} />
          <span className='kw-sec-title'>{e('kwUserGroup')}</span>
          <span className='kw-badge'>
            {userGroups.filter(g => g.name).length} {e('kwSubGroups')} · {e('keyword')} {userRuleOn}/{userRuleTotal}
          </span>
        </div>
        {
          openSec.user
            ? (
              <div className='kw-sec-body'>
                {userGroups.length
                  ? userGroups.map(renderUserGroup)
                  : <div className='kw-empty'>{e('kwNoRules')}</div>}
              </div>
              )
            : null
        }
      </div>
    </div>
  )
}
