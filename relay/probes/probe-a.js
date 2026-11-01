(async () => {
  const out = {}
  out.url = location.href
  out.testids = [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].slice(0, 80)

  const sels = [
    'article',
    '[data-testid^="conversation-turn"]',
    '[data-message-id]',
    '[data-message-author-role]',
    '.markdown',
    '.prose',
    '[class*="markdown"]',
    '[class*="assistant"]',
    'section',
    'main',
  ]
  out.counts = {}
  for (const s of sels) out.counts[s] = document.querySelectorAll(s).length
  out.mainHtmlHead = (document.querySelector('main') || document.body).outerHTML.slice(0, 1200)

  const labels = []
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    const t = (n.nodeValue || '').trim()
    if (t === 'ChatGPT 说：' || t === 'ChatGPT 说' || t === '你说：' || t === '你说') {
      const chain = []
      let el = n.parentElement
      for (let i = 0; i < 8 && el; i += 1) {
        chain.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 140),
          tid: el.getAttribute ? el.getAttribute('data-testid') || '' : '',
          kids: el.childElementCount,
        })
        el = el.parentElement
      }
      labels.push({ text: t, chain })
    }
  }
  out.labelCount = labels.length
  out.labels = labels.slice(-3)

  const md = [...document.querySelectorAll('div,article,section')]
    .filter((e) => /markdown|prose|message/i.test(String(e.className || '')))
    .slice(-6)
    .map((e) => ({
      tag: e.tagName,
      cls: String(e.className).slice(0, 160),
      len: (e.innerText || '').length,
      html: e.outerHTML.slice(0, 500),
    }))
  out.mdCandidates = md

  return out
})()
