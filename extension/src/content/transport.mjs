export async function sendResult(payload) {
  try {
    await chrome.runtime.sendMessage({ type: 'result', payload })
  } catch (err) {
    console.warn('[gpt-relay] result failed', err)
  }
}
