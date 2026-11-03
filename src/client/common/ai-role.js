/**
 * The AI system role, in one place.
 *
 * Why this exists: "answer in the user's language" was pasted as a Chinese
 * literal (`;用[x]回复`) at four AI-chat call sites, while every other generated
 * prompt in the app asks in English (agent loop, quick-command / bookmark /
 * theme generators) -- as does the UI itself. Four copies also meant four
 * places to touch whenever the role is joined: an empty `roleAI` used to yield
 * a role starting with `;`, and a missing language yielded `Reply in  language`.
 */

/**
 * Which language the model should answer in: the configured one when set,
 * otherwise the interface language the caller already resolved.
 */
export function resolveAiLanguage (languageAI, uiLanguage = '') {
  const configured = typeof languageAI === 'string' ? languageAI.trim() : ''
  return configured || String(uiLanguage || '').trim()
}

/**
 * The sentence on its own, for prompts that place it themselves (the agent loop
 * puts it at the end of a longer instruction block).
 */
export function replyLanguageInstruction (languageAI, uiLanguage = '') {
  const lang = resolveAiLanguage(languageAI, uiLanguage)
  return lang ? `Reply in ${lang} language` : ''
}

/**
 * Build the system role sent with an AI request.
 * The language instruction is appended on its own line so it stays separable
 * from whatever the user wrote in `roleAI`.
 */
export function buildAiRole (entry = {}, uiLanguage = '') {
  const role = typeof entry.roleAI === 'string' ? entry.roleAI.trim() : ''
  const instruction = replyLanguageInstruction(entry.languageAI, uiLanguage)
  if (!instruction) {
    return role
  }
  return role ? `${role}\n${instruction}` : instruction
}
