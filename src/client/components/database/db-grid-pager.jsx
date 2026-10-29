/**
 * H1a-4（网格复用整合）：数据网格工具行公共件 —— 分页条 + 过滤输入。
 *
 * 为什么收进来：数据页（MySQL/Redis 键列表）与 SQL 结果页原来各写一份
 * 「页码 + 跳页 + 页大小 + 总数」，样式都挂在 .db-grid-pager/.db-grid-jump
 * 这组 class 上，行为却有三套实现（div 手搓 / antd Pagination / SCAN 步进）。
 * 这里只统一**结构与样式**，状态归各自页面持有（SQL 结果的过滤是"整份结果"，
 * 数据页的是"当前页"，语义不同，不强行合并状态）。
 */
import React from 'react'
import { Button, Input, InputNumber } from 'antd'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'

const e = window.translate

/**
 * 网格分页条：上一页 / 页码（可选页码标签窗口）/ 下一页 / 跳页 / Go / 可选总数。
 *
 * @param {Object}   props
 * @param {Function} props.onPrev          上一页回调
 * @param {boolean}  [props.prevDisabled]
 * @param {Function} props.onNext          下一页回调
 * @param {boolean}  [props.nextDisabled]
 * @param {ReactNode} [props.pageTags]     页码标签窗口（数据页 renderPageTags 的产物，
 *                                        Redis 键列表没有标签窗口）
 * @param {string}   props.pageNoText      页码文案（e('dbPageLabel') / dbPageOfLabel 拼好传入）
 * @param {string}   [props.pageNoTitle]   页码悬停提示（Redis 键列表把键数挂这里）
 * @param {Object}   [props.jump]          跳页输入配置；缺省不渲染跳页
 * @param {boolean}  [props.jump.numeric]  true 走 InputNumber（数据页/SQL 结果，回车即跳），
 *                                         false 走 Input（Redis SCAN 跳页，文本草稿）
 * @param {*}        [props.jump.value]
 * @param {Function} [props.jump.onChange] 原生 onChange 语义：Input 传事件、InputNumber 传值
 * @param {Function} [props.jump.onPressEnter]
 * @param {string}   [props.jump.placeholder]
 * @param {number}   [props.jump.min]      InputNumber 下界
 * @param {number}   [props.jump.max]      InputNumber 上界（总页数为估算时传 undefined）
 * @param {boolean}  [props.jump.disabled]
 * @param {boolean}  [props.goDisabled]
 * @param {Function} props.onGo            Go 按钮（跳页确认）
 * @param {string}   [props.totalText]     可选「总数」文案（SQL 结果：dbResultTotal）
 * @returns {JSX.Element}
 */
export function DbGridPager (props) {
  const {
    onPrev,
    prevDisabled = false,
    onNext,
    nextDisabled = false,
    pageTags = null,
    pageNoText = '',
    pageNoTitle,
    jump = null,
    goDisabled = false,
    onGo,
    totalText = null
  } = props
  return (
    <div className='db-grid-pager'>
      <Button
        size='small'
        icon={<LeftOutlined />}
        disabled={prevDisabled}
        onClick={onPrev}
      />
      {pageTags}
      <span className='db-grid-page-no' title={pageNoTitle}>{pageNoText}</span>
      <Button
        size='small'
        icon={<RightOutlined />}
        disabled={nextDisabled}
        onClick={onNext}
      />
      {
        jump
          ? (
              jump.numeric
                ? (
                  <InputNumber
                    size='small'
                    min={jump.min}
                    max={jump.max}
                    value={jump.value}
                    onChange={v => jump.onChange(v)}
                    onPressEnter={ev => jump.onPressEnter(ev)}
                    className='db-grid-jump'
                    placeholder={jump.placeholder}
                  />
                  )
                : (
                  <Input
                    size='small'
                    className='db-grid-jump'
                    placeholder={jump.placeholder}
                    value={jump.value}
                    onChange={ev => jump.onChange(ev)}
                    onPressEnter={ev => jump.onPressEnter(ev)}
                    disabled={jump.disabled}
                  />
                  )
            )
          : null
      }
      <Button size='small' disabled={goDisabled} onClick={onGo}>
        {e('dbGo')}
      </Button>
      {
        // 近似总行数（次要信息）：数据页总数在网格头 .db-grid-total 里，
        // SQL 结果的分页器承担总数展示（antd Pagination showTotal 的等价物）
        totalText
          ? <span className='db-grid-total'>{totalText}</span>
          : null
      }
    </div>
  )
}

/**
 * 网格过滤输入：防抖由调用方的 onChange 语义决定（SQL 结果 150ms 防抖、
 * 数据页即时高亮），这里只统一「输入框 + 可选命中/总数」的外观与结构。
 *
 * @param {Object}   props
 * @param {string}   props.className     输入框 class（db-page-filter / db-sql-filter）
 * @param {*}        props.value
 * @param {Function} props.onChange
 * @param {Function} [props.onKeyDown]   （数据页 Esc 清空过滤）
 * @param {string}   props.placeholder
 * @param {string}   [props.title]       悬停提示
 * @param {boolean}  [props.allowClear]
 * @param {ReactNode} [props.suffix]     输入框尾部图标（SQL 结果：SearchOutlined）
 * @param {string}   [props.count]       命中/总数文案；空串/null 不渲染计数
 * @param {string}   [props.countClass]  计数 class（数据页 db-page-filter-count、
 *                                       SQL 结果 db-sql-filter-hit[-empty]）
 * @returns {JSX.Element}
 */
export function DbGridFilter (props) {
  const {
    className,
    value,
    onChange,
    onKeyDown,
    placeholder,
    title,
    allowClear = true,
    suffix,
    count = null,
    countClass = 'db-page-filter-count'
  } = props
  return (
    <>
      <Input
        size='small'
        className={className}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        title={title}
        allowClear={allowClear}
        suffix={suffix}
      />
      {
        count
          ? <span className={countClass}>{count}</span>
          : null
      }
    </>
  )
}
