import { visible } from './shared.mjs'

export function editableCandidates() {
  return [...document.querySelectorAll('div[contenteditable="true"], textarea')].filter(visible)
}

export function findComposer(sels) {
  const direct = document.querySelector(sels.composer)
  if (visible(direct)) return direct
  const list = editableCandidates()
  if (!list.length) return null
  // The composer is the editable sitting lowest on the page.
  list.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)
  return list[0]
}

export function findSend(composer, sels) {
  const direct = document.querySelector(sels.send)
  if (visible(direct)) return direct
  const labelled = [...document.querySelectorAll('button[aria-label]')].filter((b) => {
    const label = (b.getAttribute('aria-label') || '').toLowerCase()
    return /send|发送|提交/.test(label) && visible(b)
  })
  if (labelled.length) return labelled[0]
  const form = composer.closest('form')
  const submit = form && form.querySelector('button[type="submit"]')
  if (visible(submit)) return submit
  return null
}

export function composerText(el) {
  if (!el) return ''
  return (el.tagName === 'TEXTAREA' ? el.value : el.innerText) || ''
}

export function assistantNodes(sels) {
  const primary = [...document.querySelectorAll(sels.assistant)]
  if (primary.length) return primary
  // A whole turn may include a user question and several assistant messages.
  // Never treat that container (or the user's question) as an assistant reply.
  return [...document.querySelectorAll('[data-message-author-role="assistant"],[data-markdown-text-style="assistant-message"]')]
    .filter(n=>!n.querySelector('[data-message-author-role="assistant"],[data-markdown-text-style="assistant-message"]'))
}

export function stopVisible(sels) {
  if (document.querySelector(sels.stop)) return true
  if (document.querySelector('[data-testid*="stop" i]')) return true
  return [...document.querySelectorAll('button[aria-label]')].some((b) => {
    const label = (b.getAttribute('aria-label') || '').toLowerCase()
    return /stop|停止/.test(label)
  })
}

export function buttonsReport() {
  return [...document.querySelectorAll('button')].map((b) => ({
    testid: b.dataset.testid || b.getAttribute('data-testid') || '',
    aria: b.getAttribute('aria-label') || '',
    title: b.getAttribute('title') || '',
    text: (b.innerText || '').trim().slice(0, 24),
    cls: String(b.className || '').slice(0, 80),
    disabled: !!b.disabled,
    visible: visible(b),
  }))
}
