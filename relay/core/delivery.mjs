import path from 'node:path'
import { splitChunks, toWechat } from '../format.mjs'

function workspaceName(wsPath) {
  try { return path.basename(wsPath) } catch { return wsPath }
}

// dsh-wechat-send exit codes: 0 sent, 2 usage / no bound conversation,
// 3 refused because the reply window is used up (queued, do not retry).
export function wechatReason(code) {
  if (code === 0) return 'ok'
  if (code === 2) return 'no-wechat-conversation-bound'
  if (code === 3) return 'wechat-window-closed'
  return 'wechat-send-failed'
}

/** A screenshot for every captured answer; preserve text, continuation labels and delays. */
export function buildDeliveryPlan({ job, markdown, screenshot, screenshots, chunkChars, now }) {
  const text = toWechat(markdown)
  const chunks = splitChunks(text, chunkChars)
  const seconds = Math.round((now - job.createdAt) / 1000)
  const label = workspaceName(job.ws)
  const title = `【GPT 回答·${seconds}s·${label}】`
  const rich = (job.meta && job.meta.rich) || {}
  const overlay = job.meta && job.meta.overlay
  if (overlay && overlay.action === 'chose' && chunks.length) {
    chunks[0] = `（页面弹窗我替你选了「${overlay.label}」，可在网页里改）\n${chunks[0]}`
  }
  const url = job.meta && job.meta.url
  const needsLink = url && ((rich.canvas || 0) > 0 || markdown.length > 500)
  const supplied=Array.isArray(screenshots) ? screenshots : (screenshot ? [screenshot] : [])
  const valid=data=>typeof data==='string' && /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.test(data)
  const shots=supplied.length && supplied.every(valid) ? supplied : []
  const expected=job.meta?.screenshotInfo?.pages
  const captureError=supplied.length && !shots.length ? 'capture-pages-invalid' : expected && expected!==shots.length ? 'capture-pages-incomplete' : ''
  const wantsShot = shots.length>0 && !captureError

  const messages = []
  if (wantsShot) for(let i=0;i<shots.length;i++) messages.push(shots.length===1
    ? {text:title,file:'screenshot'}
    : {text:`${title}（截图 ${i+1}/${shots.length}）`,file:'screenshot',pageIndex:i})
  const firstHead = wantsShot ? '（文字版）\n' : `${title}\n`
  if (chunks.length === 1) {
    messages.push({ text: firstHead + chunks[0] })
  } else if (chunks.length <= 4) {
    for (let i = 0; i < chunks.length; i += 1) {
      const head = i === 0 ? firstHead : `（续 ${i + 1}/${chunks.length}）\n`
      messages.push({ text: head + chunks[i], delayAfter: 800 })
    }
  } else {
    for (let i = 0; i < 3; i += 1) {
      const head = i === 0 ? firstHead : `（续 ${i + 1}/3）\n`
      messages.push({ text: head + chunks[i], delayAfter: 800 })
    }
    messages.push({ text: `……全文 ${text.length} 字，完整版见文件。`, file: 'answer' })
  }
  return { text, chunks, wantsShot, shots:wantsShot?shots:[],captureError,messages, link: needsLink ? `🔗 网页原文：${url}` : '' }
}

/** Execute the plan against injected storage and sender; no plugin is invoked by policy tests. */
export function createDelivery({ config, storage, sendWechat, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return async function deliverAnswer(job, markdown, images, screenshot, screenshots) {
    const file = path.join(await storage.scopeBase(job), `${job.id}.md`)
    await storage.writeText(file, markdown)
    await storage.journal(job, markdown)
    const plan = buildDeliveryPlan({ job, markdown, screenshot, screenshots,chunkChars: config.chunkChars, now: Date.now() })
    const shotPages=plan.shots.map((_,index)=>({index:index+1,total:plan.shots.length,file:null,sent:false,error:''}))
    let screenshotSent = false
    let screenshotError = plan.wantsShot ? '' : (plan.captureError || job.meta?.screenshotError || 'capture-missing')
    for(const [index,data] of plan.shots.entries()) {
      try {
        const name=plan.shots.length===1 ? 'answer.png' : `answer-${String(index+1).padStart(3,'0')}.png`
        const target=path.join(await storage.mediaBase(job),name)
        if(await storage.writeDataUrl(target,data)===false) throw new Error('invalid screenshot data')
        shotPages[index].file=target
      } catch {shotPages[index].error='screenshot-save-failed';screenshotError='screenshot-save-failed'}
    }
    const shotStatus=()=>({shot:shotPages.some(p=>p.file),screenshotSent,
      screenshotFile:shotPages[0]?.file || null,screenshotFiles:shotPages.map(p=>p.file),
      screenshotPages:shotPages,screenshotCount:shotPages.length,screenshotsSent:shotPages.filter(p=>p.sent).length,screenshotError})
    // Compatibility: silent asks do not save original images or send messages.
    if (job.silent) return { file, images: 0, chunks: 0, silent: true, ...shotStatus(), screenshotError:screenshotError || 'silent', errors:[] }

    const errors=[]
    async function send(text,file) {
      try {
        const result=file ? await sendWechat(text,file) : await sendWechat(text)
        if(result?.code===0) return true
        const code=result?.code ?? -1
        errors.push({code,file:file || '',reason:wechatReason(code),stderr:String(result?.stderr || '').slice(0,200)})
      } catch (error) {
        errors.push({code:-1,file:file || '',reason:wechatReason(-1),stderr:String(error?.message || error).slice(0,200)})
      }
      return false
    }
    let warned=false
    for (const message of plan.messages) {
      if (message.file === 'screenshot') {
        const page=shotPages[message.pageIndex || 0]
        if(page.file) {
          page.sent=await send(message.text,page.file)
          if(!page.sent) {page.error='screenshot-send-failed';screenshotError='screenshot-send-failed'}
        }
        screenshotSent=shotPages.length>0 && shotPages.every(p=>p.sent)
        if(shotPages.length>1) await sleep(600)
        continue
      }
      let text=message.text
      if(!screenshotSent && !warned) {
        const warning=shotPages.length>1 ? `⚠️ 本次截图仅送达 ${shotPages.filter(p=>p.sent).length}/${shotPages.length} 张，未送达：${shotPages.filter(p=>!p.sent).map(p=>p.index).join('、')}。` : '⚠️ 本次截图未能送达，文字回答先发给你。'
        text=warning+'\n'+text;warned=true
      }
      await send(text,message.file==='answer'?file:undefined)
      if (message.delayAfter) await sleep(message.delayAfter)
    }
    if(!screenshotSent && !warned) await send('⚠️ 本次截图未能送达，请稍后重试。')
    const imageFiles = await storage.saveImages(job, images)
    for (const image of imageFiles.slice(0, 4)) {
      await send('', image)
      await sleep(600)
    }
    if (plan.link) await send(plan.link)
    return { file, images: imageFiles.length, chunks: plan.chunks.length, ...shotStatus(), errors, wechatError: errors[0] || null }
  }
}
