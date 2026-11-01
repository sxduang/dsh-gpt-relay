import { sleep, seen, ANSWER_WAIT_MS } from './shared.mjs'
import { findComposer, composerText, findSend, buttonsReport, stopVisible, assistantNodes } from './ui.mjs'
import { setText, clearComposer, waitSendReady, pressEnter, scrollToBottom } from './typing.mjs'
import { dismissOverlays } from './overlays.mjs'
import { waitAnswer } from './wait-answer.mjs'
import { collectImages } from './images.mjs'
import { extractMd, richness } from './extract.mjs'
import { screenshotNode, screenshotViewport } from './capture.mjs'
import { dumpReport } from './diagnostics.mjs'
import { attachmentState, uploadAttachments, waitAttachments } from './attachments.mjs'
import { readUploadDraft, saveUploadDraft, clearUploadDraft, verifyUploadDraft } from './upload-draft.mjs'
import { createAnswerTracker } from './answer-target.mjs'
import { describeAnswerAnchor } from '../shared/answer-anchor.mjs'

export async function runDryrun(sels) {
  const readiness = await chrome.runtime.sendMessage({type:'prepare-input'})
  if (!readiness?.ok) return {status:'error',error:readiness?.error || 'input-check-failed',detail:readiness?.detail || '无法确认页面输入状态'}
  const composer = findComposer(sels)
  if (!composer) return { status: 'error', error: 'no-composer', detail: '找不到输入框', report: dumpReport(sels) }
  if (composerText(composer).trim() || attachmentState(composer, sels).count) {
    return { status: 'error', error: 'composer-busy', detail: '输入框里有你正在写的内容' }
  }
  const typed = setText(composer, '__relay_probe__')
  await sleep(900)
  const report = {
    typed,
    composerText: composerText(composer).slice(0, 100),
    sendFound: !!findSend(composer, sels),
    buttons: buttonsReport().filter((b) => b.visible || /send|发送/i.test(b.aria + b.testid + b.text)),
    stopFound: stopVisible(sels),
    assistantCount: assistantNodes(sels).length,
  }
  clearComposer(composer)
  await sleep(300)
  report.cleared = composerText(composer).trim() === ''
  report.composerAfterClear = composerText(composer).slice(0, 60)
  return { status: 'ok', report }
}

export async function runAsk(job, sels) {
  const started = Date.now()
  const readiness = await chrome.runtime.sendMessage({type:'prepare-input'})
  if (!readiness?.ok) return {status:'error',error:readiness?.error || 'input-check-failed',detail:readiness?.detail || '无法确认页面输入状态，已停止输入'}
  // A survey or preference dialog can be sitting on top of the composer; close it
  // before anything else, otherwise the text goes nowhere.
  const overlayBefore = await dismissOverlays()
  const initialComposer=findComposer(sels)
  if(!job.resumeUpload && initialComposer && (composerText(initialComposer).trim() || attachmentState(initialComposer,sels).count)) {
    return {status:'error',error:'composer-busy',detail:'页面保留着未发送草稿，已停止；不要重复 ask 或新建对话。'}
  }
  if (job.newChat && !job.resumeUpload) {
    const newChat = [...document.querySelectorAll('button[aria-label]')].find((b) =>
      /new chat|新聊天/i.test(b.getAttribute('aria-label') || ''),
    )
    if (newChat) {
      newChat.click()
      await sleep(1800)
      // Opening a new chat can raise a survey of its own.
      await dismissOverlays()
    }
  }
  let composer = findComposer(sels)
  if (!composer) {
    return {
      status: 'error',
      error: 'no-composer',
      detail: overlayBefore ? `页面被弹窗挡住：${overlayBefore.dialog?.text || overlayBefore.label || ''}` : '页面里找不到输入框（可能未登录，或界面改版）',
      report: dumpReport(sels),
      screenshot: await screenshotViewport(),
    }
  }
  // A previous attempt can leave our own question and its attachments sitting in the
  // composer (for example when the upload confirmation timed out although the file did
  // arrive). In that case adopt the draft instead of refusing to send it.
  const existingText = composerText(composer).trim()
  const existing = attachmentState(composer, sels)
  const adopt = Boolean(job.resumeUpload)
  if(adopt) {
    try {verifyUploadDraft(job,existingText,existing)} catch(error) {
      return {status:'paused',error:'upload-draft-mismatch',detail:error.message,meta:{url:location.href}}
    }
  } else if(readUploadDraft()?.phase==='sending' && (existingText || existing.count)) {
    return {status:'error',error:'image-send-unconfirmed',detail:'原草稿已尝试发送，不会重复发送。'}
  }
  if ((existingText || existing.count) && !adopt) {
    return { status: 'error', error: 'composer-busy', detail: '输入框里已有你正在写的内容，我没有动它' }
  }

  if (!adopt && !setText(composer, job.text)) {
    return { status: 'error', error: 'type-failed', detail: '文字没能写进输入框', report: dumpReport(sels) }
  }

  if (job.attachments?.length) {
    try {
      if(!adopt) saveUploadDraft(job)
      const registered=await chrome.runtime.sendMessage({type:'job-state',id:job.id,action:'draft',url:location.href})
      if(!registered?.ok) throw new Error(registered?.error || '任务已失效，停止上传和发送')
      const options={getComposer:()=>findComposer(sels),validate:current=>verifyUploadDraft(job,composerText(current),attachmentState(current,sels))}
      composer=await (adopt ? waitAttachments(job,composer,sels,options) : uploadAttachments(job,composer,sels,options))
    } catch (error) {
      if(error.code==='upload-pending') return {status:'paused',error:'upload-pending',detail:error.message,meta:{url:location.href}}
      return { status: 'error', error: 'image-upload-failed', detail: error.message }
    }
  }
  const send = await waitSendReady(composer, sels)
  const uploaded = job.attachments?.length ? attachmentState(composer, sels) : null
  if (uploaded && (!send || uploaded.count !== job.attachments.length || uploaded.busy || uploaded.error)) {
    return { status:'paused',error:'upload-pending',detail:'附件状态发生变化，保留原草稿等待继续。',meta:{url:location.href} }
  }
  const beforeSend = await chrome.runtime.sendMessage({type:'prepare-input'})
  if (!beforeSend?.ok) return {status:'error',error:beforeSend?.error || 'input-check-failed',detail:beforeSend?.detail || '页面输入状态变化，已停止发送'}
  // Uploading can take minutes; snapshot history only once the draft is ready.
  const beforeAnswers=assistantNodes(sels)
  beforeAnswers.forEach(n=>seen.add(n))
  // job.anchor needs a worker restart; the prompt format already carries the
  // question after 【问题】, so derive it locally as a fallback.
  const anchor=job.anchor || (String(job.text).includes('【问题】') ? String(job.text).split('【问题】').pop().trim() : '')
  const answerTracker=createAnswerTracker(beforeAnswers,{question:job.text,anchor})
  if (!answerTracker.canSend()) {
    return {status:job.attachments?.length?'paused':'error',error:'conversation-not-ready',detail:'原对话尚未加载到可核对的问题位置，保留草稿并停止发送；不会新建对话或采用旧回答。',meta:{url:location.href}}
  }
  if(job.attachments?.length) {
    verifyUploadDraft(job,composerText(composer),attachmentState(composer,sels))
    const permitted=await chrome.runtime.sendMessage({type:'job-state',id:job.id,action:'claim-send',url:location.href})
    if(!permitted?.ok) return {status:'error',error:'send-not-authorized',detail:permitted?.error || '任务已失效，不会发送'}
    if(!composer.isConnected || composerText(composer).trim()!==job.text.trim() || send.disabled || send.getAttribute('aria-disabled')==='true') return {status:'error',error:'image-send-unconfirmed',detail:'提交前页面发生变化，停止自动发送，请核对原草稿。'}
    saveUploadDraft(job,'sending')
  }
  if (send) send.click()
  else pressEnter(composer)
  const sentAt = Date.now()

  await sleep(1200)
  if(job.attachments?.length) {
    // Upload readiness and request acknowledgement are separate. A slow network
    // can leave a sent draft visible briefly; never click send a second time.
    const confirmUntil=Date.now()+15000
    let confirmed=false
    while(Date.now()<confirmUntil) {
      const current=findComposer(sels)
      if(answerTracker.find(assistantNodes(sels)) || (current && !composerText(current).trim() && !attachmentState(current,sels).count)) {confirmed=true;break}
      await sleep(250)
    }
    if(!confirmed) return {status:'error',error:'image-send-unconfirmed',detail:'已点击发送，但网页尚未确认；为避免重复提问，不会再次点击或新建对话。'}
    await chrome.runtime.sendMessage({type:'job-state',id:job.id,action:'submitted',url:location.href})
  }
  if (!job.attachments?.length && !assistantNodes(sels).some((n) => !seen.has(n)) && composerText(composer).trim() === job.text.trim()) {
    // Nothing happened: try the Enter key as a second attempt.
    pressEnter(composer)
    await sleep(1500)
  }
  scrollToBottom(sels)
  if(job.attachments?.length) clearUploadDraft(job.id)

  const answer = await waitAnswer(Date.now() + ANSWER_WAIT_MS, sels, sentAt, answerTracker)
  if (answer && answer.blocked) {
    return {
      status: 'error',
      error: 'dialog-blocked',
      detail: `弹窗挡住了操作：${answer.dialog.text}`,
      report: { dialog: answer.dialog, ...dumpReport(sels) },
      screenshot: await screenshotViewport(),
    }
  }
  if (!answer) {
    return {
      status: 'error',
      error: 'no-answer',
      detail: `尚未确认本次问题的完整回答，已停止截图；不会用旧回答或当前屏幕代替。请核对原任务，不要重复提问。诊断：${JSON.stringify(answerTracker.debug())}`,
    }
  }

  const scrolled = 'answer-anchor'
  // Image collection can yield while React replaces the answer node.
  if (answerTracker.find(assistantNodes(sels))!==answer.node || !answerTracker.isComplete(answer.node)) {
    return {status:'error',error:'answer-binding-lost',detail:'无法确认当前回答属于本次问题，已停止截图，不使用历史回答替代。'}
  }
  const captureIdentity = describeAnswerAnchor(answer.node)
  const markdown=extractMd(answer.node)
  const images = await collectImages(answer.node)
  const rich = richness(answer.node)
  const shot = await screenshotNode(answer.node, sels, job.id, captureIdentity)

  return {
    status: 'ok',
    markdown,
    images,
    screenshot: shot.dataUrl,
    screenshotPages: shot.dataUrls,
    meta: {
      durationMs: Date.now() - started,
      answerBinding: answerTracker.binding(),
      timedOut: !!answer.timedOut,
      sendBy: send ? 'button' : 'enter',
      scrolled,
      images: images.length,
      rich,
      screenshot: !!(shot.dataUrl || shot.dataUrls?.length),
      screenshotInfo: shot.info || null,
      screenshotError: shot.error || null,
      screenshotDetail: shot.detail || null,
      overlay: overlayBefore || answer.dismissed || null,
      assistantCount: assistantNodes(sels).length,
      url: location.href,
    },
  }
}
