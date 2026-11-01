import { sleep, seen } from './shared.mjs'
import { assistantNodes, stopVisible } from './ui.mjs'
import { dismissOverlays, visibleDialogs, dialogSummary } from './overlays.mjs'

export async function waitAnswer(deadline, sels, sentAt, tracker) {
  let lastText = ''
  let lastNode = null
  let stable = 0
  let started = false
  let node = null
  let dismissed = null
  let idleChecks = 0

  while (Date.now() < deadline) {
    await sleep(800)
    const nodes = assistantNodes(sels)
    const candidate = tracker ? tracker.find(nodes) : null
    const fresh = tracker ? (candidate ? [candidate] : []) : nodes.filter((n) => !seen.has(n))
    if (fresh.length) started = true
    if (!started) {
      idleChecks += 1
      // Every ~4s, try to clear whatever is sitting on top of the composer.
      if (idleChecks % 5 === 0) {
        const result = await dismissOverlays()
        if (result) dismissed = result
      }
      // A dialog that will not go away is a failure, not something to wait out.
      if (sentAt && Date.now() - sentAt > 20000) {
        const dialogs = visibleDialogs()
        if (dialogs.length) return { blocked: true, dialog: dialogSummary(dialogs[0]) }
      }
      continue
    }
    node = fresh.length ? fresh[fresh.length - 1] : (tracker ? null : nodes[nodes.length - 1])
    if (!node) { stable=0; lastText=''; lastNode=null; continue }
    const text = (node.innerText || '').trim()
    if (!text) continue
    // The reasoning toggle ("思考了 12s") is not the answer.
    if (/^思考了\s*\d/.test(text) && text.length < 12) continue
    if (text === lastText && node===lastNode) stable += 1
    else {
      lastText = text
      stable = 0
    }
    lastNode=node
    if (!stopVisible(sels) && stable >= 2 && (!tracker || tracker.isComplete(node))) return { node, text, dismissed }
  }
  // A deadline is not proof of completion; never publish the last intermediate
  // message merely because waiting ended.
  return null
}
