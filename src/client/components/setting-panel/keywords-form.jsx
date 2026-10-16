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
  setPresetRuleOn,
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
    rule, editable, checked, themeConfig, onToggle, onColor, onKeyword, onRemove, dupPreset
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

  const isOn = checked === undefined ? isRuleOn(rule) : checked

  return (
    <div className={'kw-rule' + (isOn ? '' : ' off')}>
      <TriCheck
        checked={isOn}
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
  // 新建分组：输入组名 → 在该组建一条空规则（分组按 rule.group 派生，空组不存在）
  const [addingGroup, setAddingGroup] = useState(false)
  const [addGroupName, setAddGroupName] = useState('')
  // enter 后紧跟 blur 会触发两次 commit，用 ref 保证只提交一次
  const addGroupRef = useRef(false)

  const commit = next => props.submit({ keywords: next })
  const presetViews = allPresetViews(list)
  const userGroups = userGroupViews(list)
  const dupIndex = useMemo(presetKeywordIndex, [])
  const filtering = !!q || onlyOn

  // entries 统一带 keyword/on（预设条目按预设规则表展开，未应用也在列表里）
  const match = (entry) => {
    if (q && !entry.keyword.includes(q)) {
      return false
    }
    if (onlyOn && !entry.on) {
      return false
    }
    return true
  }
  const visibleEntries = entries => entries.filter(match)

  const appliedPresets = presetViews.filter(v => v.on > 0)
  const presetRuleOn = presetViews.reduce((n, v) => n + v.on, 0)
  const presetRuleTotal = presetViews.reduce((n, v) => n + v.total, 0)
  // 表单里可能有一条尚未填写的空规则（默认行），不计入统计
  const realEntries = entries => entries.filter(({ rule }) => rule.keyword)
  const userRuleOn = userGroups.reduce((n, g) => {
    return n + realEntries(g.entries).filter(entry => entry.on).length
  }, 0)
  const userRuleTotal = userGroups.reduce((n, g) => n + realEntries(g.entries).length, 0)

  const toggleSec = key => setOpenSec(s => ({ ...s, [key]: !s[key] }))
  const toggleGrp = key => setOpenGrp(s => ({ ...s, [key]: !s[key] }))
  const isOpen = key => filtering || !!openGrp[key]

  // 新增用户规则：空态/具名分组也提供入口，并自动展开所在分组
  const addUser = (group = '') => {
    setOpenSec(s => ({ ...s, user: true }))
    setOpenGrp(s => ({ ...s, [`u:${group}`]: true }))
    commit(addUserRule(list, { group }))
  }

  // 新建分组：组名合法即在该组建一条空规则并展开
  const commitAddGroup = () => {
    if (!addGroupRef.current) {
      return
    }
    addGroupRef.current = false
    const name = addGroupName.trim()
    setAddingGroup(false)
    setAddGroupName('')
    if (!name) {
      return
    }
    if (userGroups.some(g => g.name === name)) {
      message.error(e('kwGroupNameExists'))
      return
    }
    setOpenSec(s => ({ ...s, user: true }))
    setOpenGrp(s => ({ ...s, [`u:${name}`]: true }))
    commit(addUserRule(list, { group: name }))
  }

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

  // 预设规则按关键字定位（可能还没进配置），用户规则按下标
  const renderRule = (entry, preset) => {
    const { rule, index } = entry
    const isPreset = rule.source === 'preset'
    return (
      <RuleRow
        key={isPreset ? 'p' + entry.keyword : 'r' + index}
        rule={rule}
        checked={entry.on}
        editable={!isPreset}
        themeConfig={themeConfig}
        onToggle={on => commit(isPreset
          ? setPresetRuleOn(list, preset, entry.keyword, on)
          : setEntryOn(list, index, on))}
        onColor={color => commit(updateEntry(list, index, { color }))}
        onKeyword={keyword => commit(updateEntry(list, index, { keyword }))}
        onRemove={() => commit(removeEntry(list, index))}
        dupPreset={isPreset ? null : dupIndex.get(rule.keyword)}
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
            ? <div className='kw-rules'>{entries.map(e => renderRule(e, preset))}</div>
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
                {entries.map(e => renderRule(e))}
                <Button
                  type='dashed'
                  size='small'
                  className='kw-add-rule'
                  icon={<PlusOutlined />}
                  onClick={() => addUser(group.name)}
                >
                  {e('keyword')}
                </Button>
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
          <Button
            size='small'
            type='text'
            className='kw-add-group'
            icon={<PlusOutlined />}
            title={e('kwAddGroup')}
            onClick={ev => {
              ev.stopPropagation()
              // 用户区收起时 body（含组名输入框）不渲染，必须先展开
              setOpenSec(s => ({ ...s, user: true }))
              addGroupRef.current = true
              setAddingGroup(true)
            }}
          >
            {e('kwAddGroup')}
          </Button>
        </div>
        {
          openSec.user
            ? (
              <div className='kw-sec-body'>
                {
                  addingGroup
                    ? (
                      <Input
                        size='small'
                        autoFocus
                        className='kw-group-rename'
                        placeholder={e('kwGroupName')}
                        value={addGroupName}
                        onClick={ev => ev.stopPropagation()}
                        onChange={ev => setAddGroupName(ev.target.value)}
                        onPressEnter={commitAddGroup}
                        onBlur={commitAddGroup}
                      />
                      )
                    : null
                }
                {userGroups.length
                  ? userGroups.map(renderUserGroup)
                  : (
                    <div className='kw-empty'>
                      <span>{e('kwNoRules')}</span>
                      <Button
                        type='dashed'
                        size='small'
                        className='kw-add-rule'
                        icon={<PlusOutlined />}
                        onClick={() => addUser('')}
                      >
                        {e('keyword')}
                      </Button>
                    </div>
                    )}
              </div>
              )
            : null
        }
      </div>
    </div>
  )
}
