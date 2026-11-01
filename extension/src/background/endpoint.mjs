// Where the worker lives and which token to present.
//
// The build bakes in one default (single-machine installs keep working with no
// setup), but the options page writes a pairing code into chrome.storage, so a
// second machine — or a plugin-generated port/token — can override it at runtime.

let current = null

export function parsePairing(text) {
  const raw = String(text ?? '').trim()
  const match = raw.match(/^(?:https?:\/\/)?([^\s#/]+?)#([0-9a-fA-F]{8,128})$/)
  if (!match) return null
  const [, authority, token] = match
  const worker = /^https?:\/\//.test(raw) ? `http://${authority}` : `http://${authority}`
  return { worker, token: token.toLowerCase() }
}

export async function resolveEndpoint(fallback) {
  if (current) return current
  let stored = null
  try {
    const data = await chrome.storage.local.get('endpoint')
    stored = data && data.endpoint ? data.endpoint : null
  } catch {
    stored = null
  }
  const worker = String(stored?.worker || fallback.worker || 'http://127.0.0.1:8123').replace(/\/+$/, '')
  const token = String(stored?.token || fallback.token || '')
  current = { worker, token, paired: Boolean(stored?.worker && stored?.token) }
  return current
}

export function forgetEndpoint() {
  current = null
}
