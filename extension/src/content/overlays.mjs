import { sleep, visible } from './shared.mjs'

// ---- blocking overlays ---------------------------------------------------------
//
// ChatGPT occasionally raises a survey or a preference dialog over the composer.
// While it is up, typing silently does nothing and no answer ever starts, which used
// to look like "GPT never replied". These helpers find such a dialog, close it if
// there is a close control, otherwise take the first option (and say so), and give up
// quickly with a screenshot when neither works.

const DISMISS_PATTERNS = [
  /^(关闭|close|关闭对话框|×|✕)$/i,
  /跳过|skip|以后再说|not now|稍后|later|暂不|不用了|no thanks|取消|cancel/i,
  /^(确定|知道了|got it|ok|好)$/i,
]
const CONFIRM_PATTERNS = [/继续|continue|完成|done|确定|确认|保存|save|知道了|got it|开始/i]

export function visibleDialogs() {
  const found = new Set()
  const selectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    'div[data-testid*="modal"]',
    'div[class*="modal"]',
    'div[class*="Modal"]',
  ]
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (visible(el) && el.getBoundingClientRect().width > 200) found.add(el)
    }
  }
  return [...found]
}

export function clickMatchingButton(root, patterns) {
  const candidates = [...root.querySelectorAll('button, [role="button"], a')].filter(visible)
  for (const button of candidates) {
    const label = `${button.getAttribute('aria-label') || ''} ${(button.innerText || '').trim()}`.trim()
    if (!label) continue
    if (patterns.some((pattern) => pattern.test(label))) {
      button.click()
      return label.slice(0, 40)
    }
  }
  return null
}

export function dialogSummary(dialog) {
  const text = (dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const buttons = [...dialog.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 20))
    .filter(Boolean)
    .slice(0, 6)
  return { text, buttons }
}

/**
 * Close one blocking dialog. Returns a description of what was done, or null.
 * Choosing the first option is deliberate: a stuck relay is worse than a preference
 * the person can change later, and the choice is reported back to them.
 */
export async function dismissOverlays() {
  const dialogs = visibleDialogs()
  if (!dialogs.length) return null

  for (const dialog of dialogs) {
    const dismissed = clickMatchingButton(dialog, DISMISS_PATTERNS)
    if (dismissed) {
      await sleep(400)
      return { action: 'dismiss', label: dismissed }
    }
  }

  const dialog = dialogs[0]
  const option = [...dialog.querySelectorAll('[role="radio"], [role="option"], button')].filter(visible)[0]
  const summary = dialogSummary(dialog)
  if (!option) return { action: 'blocked', dialog: summary }

  const label = (option.innerText || option.getAttribute('aria-label') || '').trim().slice(0, 40)
  option.click()
  await sleep(300)
  clickMatchingButton(dialog, CONFIRM_PATTERNS)
  await sleep(400)
  return { action: 'chose', label, dialog: summary }
}
