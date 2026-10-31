export const aiConfigsArr = [
  'nameAI',
  'baseURLAI',
  'modelAI',
  'roleAI',
  'apiKeyAI',
  'authHeaderNameAI',
  'apiPathAI',
  'languageAI',
  'proxyAI',
  'contextLengthAI',
  'supportsImageAI'
]

// Keys that may legitimately be empty. `aiConfigMissing` only forces the
// config modal open when one of the *other* keys is unset, so anything
// optional has to be listed here or the modal would pop up forever.
export const optionalAIConfigsArr = [
  'apiKeyAI',
  'proxyAI',
  'nameAI',
  'contextLengthAI',
  // 老配置里没有这一项，值为空时按 auto 走；列成"可空"才不会一开面板就反复弹设置窗
  'supportsImageAI'
]

// 显式带 .js：node 的 ESM loader 不补扩展名，单测要能直接 import 这个模块
export {
  defaultAIPresets,
  getAIPresets
} from './ai-presets.js'
