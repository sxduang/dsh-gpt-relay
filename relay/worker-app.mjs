import http from 'node:http'
import path from 'node:path'
import { resolveRoot, loadConfig } from './config.mjs'
import { createLogger } from './adapters/logger.mjs'
import { createStorage } from './adapters/storage.mjs'
import { createThreadStore } from './adapters/threads.mjs'
import { createWechatSender } from './adapters/wechat.mjs'
import { createDelivery } from './core/delivery.mjs'
import { createJobQueue } from './core/jobs.mjs'
import { readBody, sendJson } from './http.mjs'
import { createResultHandler } from './results.mjs'
import { validateAttachments, IMAGE_REQUEST_LIMIT } from './core/attachments.mjs'

/** Composition root. Tests inject a sender and use an ephemeral loopback port. */
export async function createWorker(options = {}) {
  const root = options.root || resolveRoot()
  const config = options.config || await loadConfig(root)
  const log = options.log || createLogger(path.join(root, 'relay', 'relay.log'))
  const storage = createStorage({ root, log })
  await storage.init()
  const threadStore = createThreadStore(path.join(root, 'relay', 'threads.json'))
  await threadStore.load()
  const { threads } = threadStore
  const sendWechat = options.sendWechat || createWechatSender({ config, log })
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deliverAnswer = createDelivery({ config, storage, sendWechat, sleep })
  const state = { lastTabSeen: { url: '', at: 0 }, lastResult: null }
  const lifecycle = createJobQueue({ config, threads, log, sendWechat, getLastTabSeen: () => state.lastTabSeen })
  const { jobs } = lifecycle
  const startedAt = Date.now()
  const handleResult = createResultHandler({ lifecycle, storage, threadStore, sendWechat, deliverAnswer, log, sleep, state })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.searchParams.get('token') !== config.token) return sendJson(res, 403, { ok: false, error: 'bad token' })
  
    try {
      if (url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          capabilities: { imageUpload: 1, uploadResume: 1, screenshotPages: 1 },
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          queued: lifecycle.queued,
          active: lifecycle.activeId,
          lastTabSeen: state.lastTabSeen,
          jobs: jobs.size,
          lastResult: state.lastResult,
          threads: Object.keys(threads).length,
        })
      }
  
      if (url.pathname === '/hello' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        state.lastTabSeen = { url: body.url || '', at: Date.now() }
        log('hello', body.url)
        return sendJson(res, 200, { ok: true })
      }
  
      if (url.pathname === '/ask' && req.method === 'POST') {
        const kindParam = url.searchParams.get('kind')
        const kind = ['dump', 'probe', 'dryrun', 'images'].includes(kindParam) ? kindParam : 'ask'
        const json = (req.headers['content-type'] || '').split(';')[0].trim() === 'application/json'
        const raw = await readBody(req, json ? IMAGE_REQUEST_LIMIT : 2_000_000)
        let payload = null
        if (json) {
          try { payload = JSON.parse(raw) } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON' }) }
          if (!payload || typeof payload.question !== 'string') return sendJson(res, 400, { ok: false, error: 'question must be a string' })
        }
        const attachments = json ? validateAttachments(payload.images) : []
        if (attachments.length && kind !== 'ask') return sendJson(res, 400, { ok: false, error: 'images only supported for ask' })
        const question = (json ? payload.question : raw).trim() || (attachments.length ? '请分析这些图片。' : '')
        if (!question && kind === 'ask') return sendJson(res, 400, { ok: false, error: 'empty question' })
        const ws = url.searchParams.get('ws') || root
        const session = url.searchParams.get('session') || null
        const job = await lifecycle.createJob({ kind, question, ws, session, attachments, newChat: url.searchParams.get('new') === '1', silent: url.searchParams.get('silent') === '1' })
        return sendJson(res, 200, { ok: true, job: lifecycle.publicJob(job), ws: job.ws, session: job.session })
      }
  
      if (url.pathname === '/job') {
        const tab = url.searchParams.get('tab') || ''
        if (tab) state.lastTabSeen = { url: tab, at: Date.now(), uploadResume: url.searchParams.get('resume')==='1' }
        const job = lifecycle.takeJob(tab, { supportsImages: url.searchParams.get('uploads') === '1', supportsResume:url.searchParams.get('resume')==='1',tabId:url.searchParams.has('tabId')?Number(url.searchParams.get('tabId')):null })
        return sendJson(res, 200, { ok: true, job: job ? lifecycle.publicJob(job) : null })
      }
      if (url.pathname==='/job-state' && req.method==='POST') {
        const data=JSON.parse(await readBody(req))
        const job=lifecycle.jobState(data)
        // Bind the conversation as soon as a draft has a real /c/ URL, not only
        // after a successful answer. Upload delays must not discard this mapping.
        if(job.session && /^https:\/\/chatgpt\.com\/c\//.test(data.url)) {threads[job.session]={url:data.url,at:Date.now()};await threadStore.save()}
        return sendJson(res,200,{ok:true,phase:job.phase})
      }
      if (url.pathname==='/resume' && req.method==='POST') {
        const job=lifecycle.resumeJob(url.searchParams.get('id'))
        return sendJson(res,200,{ok:true,job:lifecycle.publicJob(job)})
      }
  
      if (url.pathname === '/attachment' && req.method === 'GET') {
        const job = jobs.get(url.searchParams.get('id'))
        const index = url.searchParams.get('index') || ''
        const image = /^\d+$/.test(index) && job?.status === 'running' ? job.attachments[Number(index)] : null
        if (!image?.bytes) return sendJson(res, 404, { ok: false, error: 'attachment unavailable' })
        return sendJson(res, 200, { ok: true, name: image.name, type: image.type, dataUrl: `data:${image.type};base64,${image.bytes.toString('base64')}` })
      }

      if (url.pathname === '/result' && req.method === 'POST') return await handleResult(req, res)
  
      if (url.pathname === '/status') {
        const job = jobs.get(url.searchParams.get('id') || '')
        if (!job) return sendJson(res, 404, { ok: false, error: 'unknown job' })
        return sendJson(res, 200, {
          ok: true,
          id: job.id,
          kind: job.kind,
          status: job.status,
          phase: job.phase || '',
          resumable: job.status==='paused' && !job.submitClaimed,
          draftUrl: job.draftUrl || '',
          ws: job.ws,
          session: job.session,
          error: job.error || '',
          detail: job.detail || '',
          chars: (job.markdown || '').length,
          meta: job.meta || null,
          delivery: job.delivery || null,
          reportFile: job.reportFile || '',
          answerFile: job.status === 'done' ? job.answerFile || '' : '',
          markdown: job.kind === 'dump' ? undefined : job.markdown || '',
          createdAt: job.createdAt,
          finishedAt: job.finishedAt || null,
        })
      }
  
      if (url.pathname === '/jobs') {
        return sendJson(res, 200, {
          ok: true,
          jobs: [...jobs.values()].slice(-20).map((j) => ({
            id: j.id,
            kind: j.kind,
            status: j.status,
            ws: j.ws,
            chars: (j.markdown || '').length,
            createdAt: j.createdAt,
          })),
        })
      }
  
      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      log('http error', String(err))
      return sendJson(res, err.statusCode || 500, { ok: false, error: String(err) })
    }
  })

  async function close() {
    const stopped = server.listening ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : Promise.resolve()
    await lifecycle.close()
    await stopped
    await log.flush?.()
  }
  return { server, close, jobs, log }
}
