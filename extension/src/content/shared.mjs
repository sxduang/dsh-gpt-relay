export const POLL_MS = 2000
export const ANSWER_WAIT_MS = 300000
// Set just before navigating to the conversation this DSH session owns; the freshly
// loaded page picks it up and carries on, so one question survives a page reload.
export const RESUME_KEY = '__gptRelayResume'
// Assistant messages already on screen when a job starts. Identity, not count: this
// page virtualises the transcript, so turns can be unmounted and remounted.
export const seen = new WeakSet()

export const DEFAULT_SELECTORS = {
  composer: '#prompt-textarea',
  assistant: '[data-message-author-role="assistant"]',
  turn: '[data-testid^="conversation-turn"]',
  send: '[data-testid="send-button"]',
  stop: '[data-testid="stop-button"]',
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const visible = (el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 0
