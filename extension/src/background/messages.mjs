import { jsonFetch } from './http.mjs'
import { resolveEndpoint, forgetEndpoint } from './endpoint.mjs'
import { captureNative } from './native-capture.mjs'
import { checkTabInput } from './tab-state.mjs'

export function registerMessages(fallback) {
const endpoint = () => resolveEndpoint(fallback)
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.endpoint) forgetEndpoint()
  })
} catch { /* storage events are optional outside the extension */ }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      const { worker: WORKER, token: TOKEN } = await endpoint()
      if (msg.type === 'prepare-input') {
        sendResponse(await checkTabInput(sender.tab?.id))
        return
      }
      if (msg.type === 'poll') {
        const tab = encodeURIComponent(msg.url || '')
        const data = await jsonFetch(`${WORKER}/job?tab=${tab}&uploads=1&resume=${msg.uploadResume===1?1:0}&tabId=${sender.tab?.id || ''}&token=${TOKEN}`)
        sendResponse({ ok: true, job: data.job || null })
        return
      }
      if (msg.type === 'job-state') {
        if(!sender.tab || !/^https:\/\/chatgpt\.com(?:\/|$)/.test(sender.url || sender.tab.url || '')) throw new Error('invalid job sender')
        sendResponse(await jsonFetch(`${WORKER}/job-state?token=${TOKEN}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:msg.id,action:msg.action,url:msg.url,tabId:sender.tab.id})}))
        return
      }
      if (msg.type === 'attachment') {
        if (!sender.tab || !/^https:\/\/chatgpt\.com(?:\/|$)/.test(sender.url || sender.tab.url || '')) throw new Error('invalid attachment sender')
        const query = new URLSearchParams({ id: String(msg.id), index: String(msg.index), token: TOKEN })
        sendResponse(await jsonFetch(`${WORKER}/attachment?${query}`))
        return
      }
      if (msg.type === 'result') {
        const data = await jsonFetch(`${WORKER}/result?token=${TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(msg.payload),
        })
        sendResponse({ ok: true, data })
        return
      }
      if (msg.type === 'hello') {
        const data = await jsonFetch(`${WORKER}/hello?token=${TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ url: msg.url }),
        })
        sendResponse({ ok: true, data })
        return
      }
      if (msg.type === 'fetch-image') {
        // Same fetch, but from the extension origin with host permission, for images the
        // page itself refuses to hand over.
        try {
          const res = await fetch(msg.url, { credentials: 'include' })
          if (!res.ok) throw new Error(`status ${res.status}`)
          const buf = new Uint8Array(await res.arrayBuffer())
          let binary = ''
          const step = 0x8000
          for (let i = 0; i < buf.length; i += step) {
            binary += String.fromCharCode.apply(null, buf.subarray(i, i + step))
          }
          const type = res.headers.get('content-type') || 'image/png'
          sendResponse({ ok: true, dataUrl: `data:${type};base64,${btoa(binary)}` })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
        return
      }
      if (msg.type === 'capture-viewport') {
        if (!sender.tab || sender.tab.id === undefined) {
          sendResponse({ ok: false, error: 'no tab' })
          return
        }
        const target = { tabId: sender.tab.id }
        try {
          await chrome.debugger.attach(target, '1.3')
          const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png' })
          sendResponse({ ok: true, dataUrl: `data:image/png;base64,${shot.data}` })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        } finally {
          chrome.debugger.detach(target).catch(() => {})
        }
        return
      }
      if (msg.type === 'capture') {
        if (!sender.tab || sender.tab.id === undefined) {
          sendResponse({ ok: false, error: 'no tab' })
          return
        }
        try {
          sendResponse(await captureNative(sender.tab.id, msg.rect))
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
        return
      }
      sendResponse({ ok: false, error: 'unknown message' })
    } catch (err) {
      sendResponse({ ok: false, error: String(err) })
    }
  })()
  return true
})
}
