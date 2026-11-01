import { sleep } from './shared.mjs'
import { assistantNodes } from './ui.mjs'
import { dumpReport } from './diagnostics.mjs'

/**
 * Pull the images out of one answer as data URLs.
 *
 * A picture can live at a blob: or session-scoped address that nothing else can
 * fetch later, so it is read here, where both the cookies and the blob are in
 * scope, and handed over as bytes.
 */
export function usableImage(img) {
  const src = img.currentSrc || img.src || img.dataset.src || ''
  if (!src) return false
  // Citation favicons and avatars are site chrome, not part of the answer.
  if (/favicon|s2\/favicons|sz=32|avatar/i.test(src)) return false
  if ((img.naturalWidth || 0) < 120) return false
  return true
}

export async function readImage(img) {
  const src = img.currentSrc || img.src || img.dataset.src || ''
  const alt = (img.alt || '').trim()
  if (!src) return null
  if (src.startsWith('data:')) return { alt, dataUrl: src }
  try {
    const res = await fetch(src, { credentials: 'include' })
    const blob = await res.blob()
    if (!blob.size || blob.size > 8 * 1024 * 1024) return { alt, src }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    return { alt, dataUrl }
  } catch {
    // The page may refuse the fetch; the extension origin can still get it.
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'fetch-image', url: src })
      if (resp && resp.ok && resp.dataUrl) return { alt, dataUrl: resp.dataUrl }
    } catch {
      /* fall through */
    }
    return { alt, src }
  }
}

export async function collectImages(node) {
  const out = []
  for (const img of [...node.querySelectorAll('img')].filter(usableImage).slice(0, 6)) {
    const item = await readImage(img)
    if (item) out.push(item)
  }
  return out
}

/**
 * Collect the pictures already present in this conversation, newest answer first.
 * Used to hand back an image the person asked for after the fact — nothing is sent
 * to ChatGPT and no generation quota is spent.
 */
export async function runImages(sels) {
  // Images further up the transcript are lazy: scroll through it once so every one of
  // them has actually been loaded before it is read.
  let box = document.querySelector(sels.turn) || document.body
  while (box && !(box.scrollHeight > box.clientHeight + 40)) box = box.parentElement
  if (box) {
    const original = box.scrollTop
    box.scrollTop = 0
    await sleep(500)
    const step = Math.max(300, box.clientHeight - 100)
    for (let y = 0; y < box.scrollHeight && y < 20000; y += step) {
      box.scrollTop = y
      await sleep(220)
    }
    box.scrollTop = original
    await sleep(300)
  }

  const nodes = assistantNodes(sels)
  const images = []
  for (let i = nodes.length - 1; i >= 0 && images.length < 4; i -= 1) {
    const found = await collectImages(nodes[i])
    for (const img of found) {
      if (!img.dataUrl) continue
      images.push(img)
      if (images.length >= 4) break
    }
  }
  if (!images.length) {
    return {
      status: 'error',
      error: 'no-images',
      detail: '这个对话里没有能取到的图片（可交互画布取不到，只能看网页）',
      report: dumpReport(sels),
    }
  }
  return { status: 'ok', images, markdown: '' }
}
