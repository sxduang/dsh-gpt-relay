import { DEFAULT_SELECTORS, RESUME_KEY, POLL_MS, sleep } from './shared.mjs'
import { runProbe, dumpReport } from './diagnostics.mjs'
import { runDryrun, runAsk } from './ask.mjs'
import { runImages } from './images.mjs'
import { sendResult } from './transport.mjs'
import { findComposer, composerText } from './ui.mjs'
import { attachmentState } from './attachments.mjs'

let busy = false

export async function handle(job) {
  busy = true
  const sels = { ...DEFAULT_SELECTORS, ...(job.selectors || {}) }
  try {
    if (job.kind === 'dump') {
      await sendResult({ id: job.id, kind: 'dump', status: 'ok', report: dumpReport(sels) })
      return
    }
    if (job.kind === 'probe') {
      const spec = JSON.parse(job.text || '{}')
      await sendResult({ id: job.id, kind: 'probe', status: 'ok', value: await runProbe(spec, sels) })
      return
    }
    if (job.kind === 'dryrun') {
      const out = await runDryrun(sels)
      await sendResult({ id: job.id, kind: 'dryrun', status: out.status, report: out.report, error: out.error, detail: out.detail })
      return
    }
    if (job.kind !== 'ask' && job.kind !== 'images') {
      await sendResult({ id: job.id, kind: job.kind, status: 'error', error: 'unknown-kind', detail: String(job.kind) })
      return
    }
    // Each DSH conversation owns one ChatGPT conversation. If the tab is showing a
    // different one, go there first and pick the job back up after the reload.
    if (job.conversationUrl && !job.newChat && !job.resumeUpload && !job.kind.startsWith('probe')) {
      try {
        const target = new URL(job.conversationUrl)
        if (target.pathname !== location.pathname) {
          const draft=findComposer(sels)
          if(draft && (composerText(draft).trim() || attachmentState(draft,sels).count)) {
            await sendResult({id:job.id,kind:job.kind,status:'error',error:'composer-busy',detail:'当前页面有未发送草稿，已停止切换对话。请继续原任务。'})
            return
          }
          sessionStorage.setItem(
            RESUME_KEY,
            JSON.stringify({ id: job.id, kind: job.kind, text: job.text, selectors: job.selectors, attachments: job.attachments, ts: Date.now() }),
          )
          location.href = job.conversationUrl
          return
        }
      } catch {
        /* unparsable url: work wherever we are */
      }
    }
    if (job.kind === 'images') {
      const out = await runImages(sels)
      await sendResult({ id: job.id, kind: 'images', ...out })
      return
    }
    const out = await runAsk(job, sels)
    await sendResult({ id: job.id, kind: 'ask', ...out })
  } catch (err) {
    await sendResult({
      id: job.id,
      kind: job.kind,
      status: 'error',
      error: job.kind === 'probe' ? 'probe-failed' : 'exception',
      detail: String(err && err.stack ? err.stack : err),
      report: job.kind === 'probe' ? undefined : dumpReport(sels),
    })
  } finally {
    busy = false
  }
}

export async function poll() {
  if (busy) return
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'poll', url: location.href, uploadResume:1 })
    if (resp && resp.ok && resp.job) await handle(resp.job)
  } catch {
    /* daemon down or extension reloaded; next tick retries */
  }
}

/** Continue a question that was interrupted by navigating to its conversation. */
export async function resumePending() {
  let raw = null
  try {
    raw = sessionStorage.getItem(RESUME_KEY)
  } catch {
    return
  }
  if (!raw) return
  try {
    sessionStorage.removeItem(RESUME_KEY)
  } catch {
    /* ignore */
  }
  let saved = null
  try {
    saved = JSON.parse(raw)
  } catch {
    return
  }
  if (!saved || !saved.id || Date.now() - (saved.ts || 0) > 5 * 60 * 1000) return

  // The conversation is still mounting; wait for the composer before typing.
  const sels = { ...DEFAULT_SELECTORS, ...(saved.selectors || {}) }
  for (let i = 0; i < 40; i += 1) {
    if (findComposer(sels)) break
    await sleep(500)
  }
  await sleep(600)
  await handle({ id: saved.id, kind: saved.kind || 'ask', text: saved.text, selectors: saved.selectors, attachments: saved.attachments, newChat: false })
}

setInterval(poll, POLL_MS)
setTimeout(async () => {
  await resumePending()
  poll()
}, 600)
chrome.runtime.sendMessage({ type: 'hello', url: location.href }).catch(() => {})
