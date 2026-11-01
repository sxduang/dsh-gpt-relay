import { scrollToBottom } from './typing.mjs'
import { extractMd } from './extract.mjs'
import { findComposer, findSend, assistantNodes, composerText, buttonsReport } from './ui.mjs'
import { describeAnswerAnchor } from '../shared/answer-anchor.mjs'
import { screenshotNode } from './capture.mjs'

export function labelChains(text, depth = 8, limit = 3) {
  const hits = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const value = (node.nodeValue || '').trim()
    if (!value.startsWith(text)) continue
    const chain = []
    let el = node.parentElement
    for (let i = 0; i < depth && el; i += 1) {
      chain.push({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 160),
        tid: el.getAttribute('data-testid') || '',
        kids: el.childElementCount,
        textLen: (el.innerText || '').length,
      })
      el = el.parentElement
    }
    hits.push({ text: value.slice(0, 40), chain })
  }
  return hits.slice(-limit)
}

export async function runProbe(spec, sels) {
  const out = { url: location.href, title: document.title, answerBindingRevision:'question-bound-v1' }
  if (spec.scroll) out.scrolled = scrollToBottom(sels)
  if (spec.counts) {
    out.counts = {}
    for (const s of spec.counts) out.counts[s] = document.querySelectorAll(s).length
  }
  if (spec.testids) {
    out.testids = [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].slice(0, 100)
  }
  if (spec.html) {
    out.html = spec.html.map((item) => {
      const els = [...document.querySelectorAll(item.sel)]
      const take = els.slice(-(item.n || 1))
      return { sel: item.sel, count: els.length, items: take.map((e) => e.outerHTML.slice(0, item.slice || 3000)) }
    })
  }
  if (spec.chains) out.chains = spec.chains.map((c) => labelChains(c.text, c.depth || 8, c.limit || 3))
  if (spec.extract) {
    const els = [...document.querySelectorAll(spec.extract)]
    const el = els[els.length - 1]
    out.extract = el ? { count: els.length, len: (el.innerText || '').length, md: extractMd(el).slice(0, 8000) } : null
  }
  if (spec.buttons) out.buttons = buttonsReport().filter((b) => b.visible)
  if (spec.bodyText) out.bodyText = (document.body.innerText || '').slice(0, spec.bodyText)
  // Diagnose an existing, explicitly identified answer without asking again or
  // sending anything to WeChat. The worker saves this in its normal probe report.
  if (spec.capture) {
    if (!spec.capture.messageId || spec.capture.url!==location.href) {
      out.capture={dataUrl:null,error:'capture-target-mismatch'}
    } else {
      const matches=assistantNodes(sels).filter(node=>{
        const identity=describeAnswerAnchor(node),r=node.getBoundingClientRect()
        return node.isConnected && r.width>100 && r.height>0 && identity?.value===spec.capture.messageId
      })
      out.capture=matches.length===1 ? await screenshotNode(matches[0],sels) : {dataUrl:null,error:'capture-target-not-unique',count:matches.length}
    }
  }
  return out
}

export function dumpReport(sels) {
  const composer = findComposer(sels)
  const send = findSend(composer, sels)
  const nodes = assistantNodes(sels)
  const last = nodes[nodes.length - 1]
  return {
    url: location.href,
    title: document.title,
    composerFound: !!composer,
    composer: composer ? composer.outerHTML.slice(0, 3000) : '',
    composerText: composerText(composer).slice(0, 200),
    sendFound: !!send,
    sendOuter: send ? send.outerHTML.slice(0, 800) : '',
    assistantCount: nodes.length,
    lastAssistantHtml: last ? last.outerHTML.slice(0, 20000) : '',
    bodyText: (document.body.innerText || '').slice(0, 1500),
    buttons: buttonsReport().filter((b) => b.visible),
  }
}
