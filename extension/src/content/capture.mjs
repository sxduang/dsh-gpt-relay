/**
 * Rasterise the answer exactly as it looks on screen.
 *
 * Text extraction throws away everything that made the answer readable: coloured
 * flow boxes, inline figures, formulas, tables. One screenshot of the turn keeps
 * all of it, which is what the person on the phone actually wants to see.
 */
import { describeAnswerAnchor } from '../shared/answer-anchor.mjs'

export async function screenshotNode(node, sels, jobId, identity = describeAnswerAnchor(node)) {
  const previous = node.getAttribute('data-gpt-relay-answer')
  const anchor = String(jobId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_')
  try {
    if (!node.isConnected && !identity) return { dataUrl: null, error: 'answer-anchor-lost' }
    node.setAttribute('data-gpt-relay-answer', anchor)
    const clip = {
      selector: `[data-gpt-relay-answer="${anchor}"]`,
      identity,
    }
    const resp = await chrome.runtime.sendMessage({ type: 'capture', rect: clip })
    if (resp && resp.ok && resp.dataUrl) return { dataUrl: resp.dataUrl, info: resp.info || null }
    if(resp?.ok && Array.isArray(resp.dataUrls) && resp.dataUrls.length) return {dataUrls:resp.dataUrls,info:resp.info || null}
    return { dataUrl: null, error: (resp && resp.error) || 'capture failed', detail: resp?.detail || null }
  } catch (err) {
    return { dataUrl: null, error: String(err) }
  } finally {
    if (previous === null) node.removeAttribute('data-gpt-relay-answer')
    else node.setAttribute('data-gpt-relay-answer', previous)
  }
}

export async function screenshotViewport() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'capture-viewport' })
    return resp && resp.ok ? resp.dataUrl : null
  } catch {
    return null
  }
}
