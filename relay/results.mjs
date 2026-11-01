import path from 'node:path'
import { readBody, sendJson } from './http.mjs'

/** Accept a page result using the original status, persistence and delivery ordering. */
export function createResultHandler({ lifecycle, storage, threadStore, sendWechat, deliverAnswer, log, sleep, state }) {
  const { jobs } = lifecycle
  const { threads } = threadStore
  return async function handleResult(req, res) {
    // Long answer screenshots and original images can exceed the old 2 MB limit.
    const body = JSON.parse((await readBody(req, 48 * 1024 * 1024)) || '{}')
    const job = jobs.get(body.id)
    if (!job) {
      log('result for unknown job', body.id)
      return sendJson(res, 404, { ok: false, error: 'unknown job' })
    }
    if(job.status==='paused' || job.status==='done' || job.status==='failed') return sendJson(res,409,{ok:false,error:'stale-or-duplicate-result'})
    if(body.status==='paused' && job.kind==='ask') {
      lifecycle.pauseJob(job)
      job.error=body.error || 'upload-pending';job.detail=body.detail || '图片等待加载，保留原草稿'
      log('job paused',{id:job.id,error:job.error,phase:job.phase})
      if(!job.silent) await sendWechat(`⏸️ 图片尚未就绪，原问题和附件已保留。加载好后可继续原任务，不必重发或新建对话。`)
      return sendJson(res,200,{ok:true,status:'paused'})
    }
    lifecycle.releaseJob(job)

    if (body.status === 'ok' && job.kind === 'images') {
      job.status = 'done'
      job.finishedAt = Date.now()
      const files = await storage.saveImages(job, body.images)
      job.meta = { images: files.length }
      for (const file of files.slice(0, 4)) {
        await sendWechat('', file)
        await sleep(500)
      }
      log('images sent', { id: job.id, count: files.length })
      return sendJson(res, 200, { ok: true, count: files.length })
    }

    if (body.status === 'ok' && job.kind !== 'ask') {
      job.status = 'done'
      job.finishedAt = Date.now()
      const payload = job.kind === 'dump' ? body.report : body.report || body.value
      const file = path.join(storage.debugDir, `${job.kind}-${job.id}.json`)
      await storage.writeJson(file, payload)
      job.reportFile = file
      log(`${job.kind} done`, { id: job.id, file })
      return sendJson(res, 200, { ok: true, file })
    }

    if (body.status === 'ok' && job.kind === 'ask') {
      job.delivery = { status:'pending' }
      job.status = 'done'
      job.finishedAt = Date.now()
      job.markdown = body.markdown || ''
      job.meta = body.meta || {}
      // Remember which ChatGPT conversation this DSH conversation owns.
      if (job.session && job.meta.url) {
        threads[job.session] = { url: job.meta.url, at: Date.now() }
        await threadStore.save()
      }
      let delivery
      try { delivery = await deliverAnswer(job, job.markdown, body.images, body.screenshot, body.screenshotPages) } catch(error) {
        job.delivery={status:'failed',screenshotSent:false,error:String(error)}
        throw error
      }
      job.delivery = { status: !job.silent && (!delivery.screenshotSent || delivery.errors.length) ? 'partial' : 'complete', ...delivery }
      job.answerFile = delivery.file
      state.lastResult = { id: job.id, status: 'ok', at: Date.now(), chars: job.markdown.length, images: delivery.images }
      log('job done', { id: job.id, chars: job.markdown.length, ws: job.ws, session: job.session, meta: job.meta, delivery:job.delivery })
      return sendJson(res, 200, { ok: true })
    }

    job.status = 'failed'
    job.finishedAt = Date.now()
    job.error = body.error || 'unknown'
    job.detail = body.detail || ''
    if (body.report) {
      const file = path.join(storage.debugDir, `error-${job.id}.json`)
      await storage.writeJson(file, body.report)
      job.reportFile = file
    }
    state.lastResult = { id: job.id, status: 'failed', error: job.error, at: Date.now() }
    log('job failed', { id: job.id, error: job.error, detail: String(job.detail).slice(0, 300) })
    await sendWechat(`⚠️ GPT 中转失败：${job.error}\n${String(job.detail).slice(0, 400)}`)
    // A failure that is a wall on the page (survey dialog, login prompt) is best
    // reported with a picture: one look tells the person what to click.
    if (typeof body.screenshot === 'string') {
      const match = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(body.screenshot)
      if (match) {
        try {
          const shot = path.join(await storage.mediaBase(job), 'error.png')
          await storage.writeDataUrl(shot, body.screenshot)
          await sendWechat('（当前页面）', shot)
        } catch (err) {
          log('error screenshot failed', String(err))
        }
      }
    }
    return sendJson(res, 200, { ok: true })
  }
}
