/**
 * 二进制信封前缀截断上限：app 侧唯一权威点（P1 T04 / O09 收口）。
 *
 * 原先 mysql / postgres / sqlite 三个适配器各写一份
 * `const BIN_PREFIX_LIMIT = 4096`，渲染层 value-renderers/index.js 另有
 * `const BIN_MAX_PREVIEW = 4096`；四处取值必须相等却没有任何一致性锁，
 * 改一侧就会让「服务端信封截断」与「渲染层预览截断」错开。
 *
 * 取值 4096 的由来：一页 400 行 × 4KB base64 前缀不会拖垮渲染，
 * 全量二进制不走 getPageData，而由独立 op getCellBinary 取回。
 * 保持原值不变，本批次只收口定义点，不改任何产品行为。
 * 三适配器不直接 require 本文件，而是经 db-type-normalize.js 共享出口解构
 * （vm 打桩 spec 以真实 db-type-normalize 模块作桩，新增相对 require 会解析失败）。
 *
 * 护栏：
 *   - 跨包取值相等：src/test/unit-ci/cross-package-defaults-ssot.spec.js ①
 *   - 无裸定义 / 共享出口形态：src/test/unit-ci/db-bin-prefix-ssot.spec.js
 */
exports.BIN_PREFIX_LIMIT = 4096
