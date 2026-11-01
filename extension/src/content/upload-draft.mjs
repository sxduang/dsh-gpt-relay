const UPLOAD_DRAFT_KEY='__gptRelayUploadDraft'

export function readUploadDraft() {
  try {return JSON.parse(sessionStorage.getItem(UPLOAD_DRAFT_KEY) || 'null')} catch {return null}
}

export function saveUploadDraft(job, phase='uploading') {
  const draft={id:job.id,text:job.text,url:location.href,phase,names:(job.attachments || []).map(image=>image.name)}
  sessionStorage.setItem(UPLOAD_DRAFT_KEY,JSON.stringify(draft))
  return draft
}

export function clearUploadDraft(id) {
  if(readUploadDraft()?.id===id) sessionStorage.removeItem(UPLOAD_DRAFT_KEY)
}

export function verifyUploadDraft(job, text, state) {
  const draft=readUploadDraft()
  if(!draft || draft.id!==job.id || draft.url!==location.href || draft.phase==='sending') throw new Error('无法确认这是原任务尚未发送的草稿，已停止；不会新建对话或重复发送。')
  if(text.trim()!==draft.text.trim()) throw new Error('原草稿文字已变化，已停止继续发送。')
  if(state.count>(job.attachments || []).length || (state.names?.length && state.names.some(name=>!draft.names.includes(name)))) throw new Error('原草稿附件已变化，已停止继续发送。')
  return draft
}
