import { sleep } from './shared.mjs'
import { findSend } from './ui.mjs'

export function attachmentScope(composer) {
  return composer.closest('form') || composer.closest('[data-testid="composer"]') || composer.parentElement
}

export function attachmentState(composer, sels) {
  const scope = attachmentScope(composer)
  if (!scope) return { count: 0, busy: false, error: '' }
  const area = scope.querySelector('[data-composer-attachments]') || scope
  const images = [...area.querySelectorAll('img')].filter(img => /^(blob:|data:image\/|https?:)/.test(img.currentSrc || img.src || ''))
  const removers = [...scope.querySelectorAll('button')].filter(button => /remove.*(image|file|attachment)|删除.*(图片|文件|附件)|移除.*(图片|文件|附件)/i.test(button.getAttribute('aria-label') || ''))
  const error = [...scope.querySelectorAll('[role="alert"], [data-testid*="error"]')].map(node => node.textContent || '').find(text => /fail|error|失败|错误|不支持|limit|限制/i.test(text)) || ''
  const busySelector=sels.uploadBusy || '[role="progressbar"], [aria-busy="true"], [data-state="uploading"], [data-testid*="uploading"]'
  return { count: Math.max(images.length, removers.length),
    names: images.map(img=>img.getAttribute?.('alt') || '').filter(Boolean),
    busy: images.some(img=>img.complete===false || img.naturalWidth===0) || !!area.matches?.(busySelector) || !!area.querySelector(busySelector), error }
}

/** Transfer pixels on demand: the job and navigation checkpoint hold metadata only. */
export async function uploadAttachments(job, composer, sels, options = {}) {
  const images = job.attachments || []
  if (!images.length) return
  if (attachmentState(composer, sels).count) throw new Error('输入框已有附件，请先处理草稿')
  const transfer = new DataTransfer()
  for (let index = 0; index < images.length; index++) {
    const response = await chrome.runtime.sendMessage({ type: 'attachment', id: job.id, index })
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error || '读取图片附件失败')
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(response.dataUrl)
    if (!match || match[1] !== images[index].type) throw new Error('图片附件格式不匹配')
    const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
    if (bytes.length !== images[index].size) throw new Error('图片附件不完整')
    transfer.items.add(new File([bytes], images[index].name, { type: images[index].type }))
  }
  const scope = attachmentScope(composer)
  const inputs = [...scope.querySelectorAll('input[type="file"]')].filter(input => !input.disabled && (!input.accept || /image|\.png|\.jp|\.webp/i.test(input.accept)))
  const input = inputs.find(candidate => images.length === 1 || candidate.multiple)
  if (input) {
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    composer.focus()
    composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }
  // Some proxies make the multipart upload to chatgpt.com very slow; a 60s window
  // failed on every real photo while the attachment did land a minute or two later.
  options.onAttached?.()
  return waitAttachments(job, composer, sels, options)
}

/** Re-observe the current composer; React may replace it during a slow upload. */
export async function waitAttachments(job, composer, sels, options = {}) {
  const wait=options.sleep || sleep, now=options.now || Date.now, sendButton=options.findSend || findSend
  const images=job.attachments || []
  const deadline = now() + (options.timeoutMs ?? 240_000)
  let readySince = null
  while (now() < deadline) {
    composer=options.getComposer ? options.getComposer() : composer
    if (!composer) {await wait(200);continue}
    options.validate?.(composer)
    const state = attachmentState(composer, sels)
    if (state.error) throw new Error(`图片上传失败：${state.error}`)
    const send = sendButton(composer, sels)
    const ready = state.count === images.length && !state.busy && send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'
    if (ready) {
      readySince ??= now()
      if (now() - readySince >= 1200) return composer
    } else readySince = null
    await wait(200)
  }
  const error=new Error('图片仍在加载，已保留原问题和附件。加载完成后继续原任务，不要重新 ask 或新建对话。')
  error.code='upload-pending'
  throw error
}
