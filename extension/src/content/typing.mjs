import { sleep } from './shared.mjs'
import { composerText, findSend, assistantNodes } from './ui.mjs'

export function setText(el, text) {
  el.focus()
  if (document.activeElement !== el && !el.contains(document.activeElement)) return false
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return composerText(el).trim().length > 0
  }
  // Replace whatever is in the editable, then insert as one text run.
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.removeAllRanges()
  sel.addRange(range)
  let ok = false
  try {
    ok = document.execCommand('insertText', false, text)
  } catch {
    ok = false
  }
  if (!ok || !composerText(el).trim()) {
    // Paste path: ProseMirror treats a paste as one insertion, newlines included.
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }
  return composerText(el).trim().length > 0
}

export function clearComposer(el) {
  if (!el) return
  el.focus()
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.removeAllRanges()
  sel.addRange(range)
  try {
    document.execCommand('delete')
  } catch {
    /* ignore */
  }
}

export async function waitSendReady(composer, sels, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const btn = findSend(composer, sels)
    if (btn && !btn.disabled) return btn
    await sleep(120)
  }
  return null
}

export function pressEnter(composer) {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  composer.dispatchEvent(new KeyboardEvent('keydown', opts))
  composer.dispatchEvent(new KeyboardEvent('keypress', opts))
  composer.dispatchEvent(new KeyboardEvent('keyup', opts))
}

/**
 * Bring the transcript back to the newest turn.
 *
 * A message appended while the tab is in the background leaves the scroll where the
 * person left it, so they come back and see yesterday's position — the message looks
 * like it was never sent. The page's own button is preferred because it also clears
 * the "new messages" affordance.
 */
export function scrollToBottom(sels) {
  const btn = [...document.querySelectorAll('button[aria-label]')].find((b) =>
    /滚动到底部|scroll to bottom/i.test(b.getAttribute('aria-label') || ''),
  )
  if (btn) {
    btn.click()
    return 'button'
  }
  const nodes = assistantNodes(sels)
  let el = nodes[nodes.length - 1]
  while (el && !(el.scrollHeight > el.clientHeight + 20)) el = el.parentElement
  if (el) {
    el.scrollTop = el.scrollHeight
    return 'container'
  }
  window.scrollTo(0, document.body.scrollHeight)
  return 'window'
}
