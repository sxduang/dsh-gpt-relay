import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { createWorker } from '../relay/worker-app.mjs'

const picture = 'data:image/png;base64,' + Buffer.from('test-image').toString('base64')

test('HTTP result persists and delivers all screenshot pages and exposes their completion',async t=>{
  const f=await fixture(t)
  const job=await f.ask('超长回答')
  await f.request('/job')
  const pages=[1,2,3].map(n=>'data:image/png;base64,'+Buffer.from('page-'+n).toString('base64'))
  const response=await f.result({id:job.id,status:'ok',markdown:'完整回答',screenshotPages:pages,meta:{screenshotInfo:{pages:3}}})
  assert.equal(response.status,200)
  const done=await f.status(job.id)
  assert.equal(done.delivery.status,'complete')
  assert.equal(done.delivery.screenshotsSent,3)
  assert.equal(done.delivery.screenshotSent,true)
  for(let i=0;i<3;i++) assert.equal(await fs.readFile(done.delivery.screenshotFiles[i],'utf8'),'page-'+(i+1))
})

test('slow upload pauses, blocks replacement asks, resumes only in its tab and grants send once',async t=>{
  const f=await fixture(t)
  const image=Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')
  const first=await f.request('/ask?session=upload-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'看图片',images:[{name:'one.png',data:image}]})})
  const id=first.body.job.id,url='https://chatgpt.com/c/original'
  assert.equal((await f.ask('已经加载好了',{session:'upload-session'})),undefined)
  assert.equal((await f.request('/job?uploads=1&resume=1&tabId=9')).body.job.id,id)
  const control=action=>f.request('/job-state',{method:'POST',body:JSON.stringify({id,action,url,tabId:9})})
  assert.equal((await control('draft')).status,200)
  assert.equal((await f.result({id,status:'paused',error:'upload-pending'})).status,200)
  assert.equal((await f.status(id)).resumable,true)
  assert.equal((await f.request('/ask?session=upload-session&new=1',{method:'POST',body:'重试'})).status,409)
  assert.equal((await f.request('/resume?id='+id,{method:'POST'})).status,200)
  assert.equal((await f.request('/resume?id='+id,{method:'POST'})).status,409)
  assert.equal((await f.request('/job?uploads=1&resume=1&tabId=10&tab='+encodeURIComponent(url))).body.job,null)
  const resumed=(await f.request('/job?uploads=1&resume=1&tabId=9&tab='+encodeURIComponent(url))).body.job
  assert.equal(resumed.id,id)
  assert.equal(resumed.newChat,false)
  assert.equal(resumed.resumeUpload,true)
  assert.equal(resumed.attachments.length,1)
  assert.equal((await f.request('/attachment?id='+id+'&index=0')).status,404,'resume uses existing draft, not released image bytes')
  assert.equal((await control('claim-send')).status,200)
  assert.equal((await control('claim-send')).status,409)
  assert.equal((await f.result({id,status:'ok',markdown:'识别结果',meta:{url}})).status,200)
  const sends=f.sent.length
  assert.equal((await f.result({id,status:'ok',markdown:'重复结果'})).status,409)
  assert.equal(f.sent.length,sends)
  assert.equal((await f.request('/resume?id='+id,{method:'POST'})).status,409)
})

test('explicit new conversation does not retain a previous navigation target',async t=>{
  const f=await fixture(t)
  const first=await f.ask('first',{session:'same'})
  await f.request('/job')
  await f.result({id:first.id,status:'ok',markdown:'answer',meta:{url:'https://chatgpt.com/c/old'}})
  const next=await f.ask('new',{session:'same',new:'1'})
  assert.equal(next.newChat,true)
  assert.equal(next.conversationUrl,'')
})

test('a long screenshot over the former 2 MB request limit is accepted and saved intact', async t=>{
  const f=await fixture(t)
  const job=await f.ask('长截图',{silent:'1'})
  await f.request('/job')
  const bytes=Buffer.alloc(1600000,123)
  const screenshot='data:image/png;base64,'+bytes.toString('base64')
  const response=await f.result({id:job.id,status:'ok',markdown:'长'.repeat(501),screenshot})
  assert.equal(response.status,200)
  const answer=await f.status(job.id)
  const saved=await fs.readFile(path.join(path.dirname(answer.answerFile),'media',job.id,'answer.png'))
  assert.deepEqual(saved,bytes)
})

test('image jobs expose metadata only, require upgraded extension and release image bytes on result', async t => {
  const f = await fixture(t)
  const data = Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')
  const response = await f.request('/ask?silent=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '看图', images: [{ name: 'photo.png', data }, { name: 'two.png', data }] }) })
  assert.equal(response.status, 200)
  const job = response.body.job
  assert.equal(job.attachments.length, 2)
  assert.deepEqual(Object.keys(job.attachments[0]).sort(), ['name', 'size', 'type'])
  assert.ok(!JSON.stringify(job).includes(data))
  assert.equal((await f.request('/job')).body.job, null)
  assert.equal((await f.request(`/attachment?id=${job.id}&index=0`)).status, 404)
  assert.equal((await f.request('/job?uploads=1')).body.job,null,'old extension must not receive the new upload protocol')
  assert.equal((await f.request('/job?uploads=1&resume=1&tabId=9')).body.job.id, job.id)
  assert.equal((await f.request(`/attachment?id=${job.id}&index=0`, {}, 'bad')).status, 403)
  assert.equal((await f.request(`/attachment?id=${job.id}&index=0`)).body.dataUrl, `data:image/png;base64,${data}`)
  assert.equal((await f.request(`/attachment?id=${job.id}&index=-1`)).status, 404)
  await f.result({ id: job.id, status: 'ok', markdown: '收到图片' })
  assert.equal(f.app.jobs.get(job.id).attachments[0].bytes, null)
  assert.equal((await f.request(`/attachment?id=${job.id}&index=0`)).status, 404)
  assert.equal(f.sent.length, 0)
})

test('malformed image requests are rejected before a task is queued', async t => {
  const f = await fixture(t)
  for (const body of ['{', JSON.stringify({ question: '看图', images: [{ data: 'aGVsbG8=' }] }), JSON.stringify({ question: '看图', images: Array(5).fill({}) })]) {
    assert.equal((await f.request('/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400)
  }
  assert.equal((await f.request('/health')).body.queued, 0)
})

async function fixture(t, overrides = {}, hooks = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-relay-worker-test-'))
  await fs.mkdir(path.join(root, 'relay'))
  const ws = path.join(root, 'workspace')
  await fs.mkdir(ws)
  await fs.writeFile(path.join(ws, 'README.md'), 'README context')
  await fs.writeFile(path.join(ws, 'AGENTS.md'), 'SECRET_AGENT_INSTRUCTIONS_MUST_NOT_BE_READ')
  const sent = []
  const config = {
    port: 0, token: 'test-token', jobTimeoutSec: 60, queueHintSec: 60,
    chunkChars: 1400, selectors: { assistant: '.test-answer' }, ...overrides,
  }
  const app = await createWorker({
    root, config, log: () => {}, sleep: async () => {},
    sendWechat: async (text, file) => {
      sent.push({ text, file })
      await hooks.onSend?.(text, file)
      return { code: 0, stderr: '' }
    },
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    await app.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  async function request(route, options = {}, token = config.token) {
    const url = new URL(route, base)
    if (token !== null) url.searchParams.set('token', token)
    const response = await fetch(url, options)
    return { status: response.status, body: await response.json() }
  }
  async function ask(question = '测试问题', parameters = {}) {
    const query = new URLSearchParams({ ws, ...parameters })
    return (await request(`/ask?${query}`, { method: 'POST', body: question })).body.job
  }
  const result = body => request('/result', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const status = async id => (await request(`/status?id=${id}`)).body
  return { root, ws, sent, app, config, request, ask, result, status }
}

test('HTTP authentication, empty input, unknown jobs and public job fields', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/health', {}, null)).status, 403)
  assert.equal((await f.request('/health', {}, 'incorrect')).status, 403)
  assert.equal((await f.request('/ask', { method: 'POST', body: '  ' })).status, 400)
  assert.equal((await f.request('/status?id=missing')).status, 404)
  assert.equal((await f.result({ id: 'missing', status: 'ok' })).status, 404)
  assert.equal((await f.request('/not-a-route')).status, 404)
  const job = await f.ask('问题', { session: 'session-a' })
  assert.deepEqual(Object.keys(job).sort(), [
    'anchor', 'conversationUrl', 'id', 'kind', 'newChat', 'resumeUpload', 'selectors', 'text', 'timeoutSec',
  ])
  // A new conversation prepends workspace context; the page re-renders it, so
  // the extension matches the question itself (anchor) instead of the prompt.
  assert.equal(job.anchor, '问题')
  assert.equal(job.kind, 'ask')
  assert.equal(job.newChat, true)
  assert.match(job.text, /README context/)
  assert.doesNotMatch(job.text, /SECRET_AGENT_INSTRUCTIONS_MUST_NOT_BE_READ/)
  assert.deepEqual(job.selectors, f.config.selectors)
})

test('FIFO queue allows one running job and releases it after result', async t => {
  const f = await fixture(t)
  const first = await f.ask('one', { kind: 'dump' })
  const second = await f.ask('two', { kind: 'dump' })
  assert.equal((await f.request('/job?tab=https://chatgpt.com/')).body.job.id, first.id)
  assert.equal((await f.request('/job')).body.job, null)
  const health = (await f.request('/health')).body
  assert.equal(health.active, first.id)
  assert.equal(health.queued, 1)
  assert.equal(health.lastTabSeen.url, 'https://chatgpt.com/')
  assert.equal((await f.status(first.id)).status, 'running')
  const report = { composer: true, buttons: ['发送'] }
  assert.equal((await f.result({ id: first.id, status: 'ok', report })).status, 200)
  const done = await f.status(first.id)
  assert.equal(done.status, 'done')
  assert.equal('markdown' in done, false)
  assert.deepEqual(JSON.parse(await fs.readFile(done.reportFile, 'utf8')), report)
  assert.equal((await f.request('/job')).body.job.id, second.id)
  assert.equal(f.sent.length, 0)
})

test('session mapping, first-message brief, new-chat reset and append-only answer journal', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.ws, '.gpt-relay'))
  await fs.writeFile(path.join(f.ws, '.gpt-relay', 'brief.md'), 'Dedicated brief')
  const session = 'session-a'
  const first = await f.ask('第一问', { session, silent: '1' })
  assert.match(first.text, /Dedicated brief/)
  assert.doesNotMatch(first.text, /README context/)
  await f.request('/job')
  const url = 'https://chatgpt.com/c/test-conversation'
  await f.result({ id: first.id, status: 'ok', markdown: '第一答', meta: { url } })
  const firstStatus = await f.status(first.id)
  const scope = path.join(f.ws, '.gpt-relay', 'sessions', session)
  assert.equal(firstStatus.answerFile, path.join(scope, `${first.id}.md`))
  assert.equal(await fs.readFile(firstStatus.answerFile, 'utf8'), '第一答')
  const mapping = JSON.parse(await fs.readFile(path.join(f.root, 'relay', 'threads.json'), 'utf8'))
  assert.equal(mapping[session].url, url)
  const second = await f.ask('第二问', { session, silent: '1' })
  assert.equal(second.newChat, false)
  assert.equal(second.text, '第二问')
  assert.equal(second.conversationUrl, url)
  await f.request('/job')
  await f.result({ id: second.id, status: 'ok', markdown: '第二答', meta: { url } })
  const journal = await fs.readFile(path.join(scope, 'journal.md'), 'utf8')
  assert.match(journal, /第一问/)
  assert.match(journal, /第一答/)
  assert.match(journal, /第二问/)
  assert.match(journal, /第二答/)
  assert.ok(journal.indexOf(first.id) < journal.indexOf(second.id))
  const reset = await f.ask('新问题', { session, new: '1' })
  assert.equal(reset.newChat, true)
  assert.match(reset.text, /【工作区背景】/)
  assert.equal((await f.request('/health')).body.threads, 1)
  assert.equal(f.sent.length, 0)
})

test('rich answer is saved and delivered as screenshot, text, original image, then link', async t => {
  const f = await fixture(t)
  const job = await f.ask('展示表格', { session: 'rich' })
  await f.request('/job')
  const markdown = '答'.repeat(501)
  const url = 'https://chatgpt.com/c/rich'
  await f.result({
    id: job.id, status: 'ok', markdown,
    meta: { url, rich: { tables: 1, images: 0 } },
    screenshot: picture, images: [{ dataUrl: picture }],
  })
  assert.equal(f.sent.length, 4)
  assert.equal(path.basename(f.sent[0].file), 'answer.png')
  assert.match(f.sent[0].text, /^【GPT 回答·\d+s·workspace】$/)
  assert.equal(f.sent[1].text, `（文字版）\n${markdown}`)
  assert.equal(path.basename(f.sent[2].file), 'img-1.png')
  assert.equal(f.sent[2].text, '')
  assert.equal(f.sent[3].text, `🔗 网页原文：${url}`)
  assert.equal(await fs.readFile(f.sent[0].file, 'utf8'), 'test-image')
  assert.equal((await f.status(job.id)).chars, 501)
})

test('failure preserves error report and sends text before screenshot even for silent ask', async t => {
  const f = await fixture(t)
  const job = await f.ask('失败测试', { silent: '1' })
  await f.request('/job')
  const report = { dialog: 'login' }
  await f.result({ id: job.id, status: 'error', error: 'no-composer', detail: 'login', report, screenshot: picture })
  const status = await f.status(job.id)
  assert.equal(status.status, 'failed')
  assert.equal(status.error, 'no-composer')
  assert.deepEqual(JSON.parse(await fs.readFile(status.reportFile, 'utf8')), report)
  assert.equal(f.sent.length, 2)
  assert.equal(f.sent[0].text, '⚠️ GPT 中转失败：no-composer\nlogin')
  assert.equal(f.sent[1].text, '（当前页面）')
  assert.equal(path.basename(f.sent[1].file), 'error.png')
  assert.equal((await f.request('/health')).body.active, null)
})

test('images job saves all images and sends at most four; diagnostic kinds use report/value', async t => {
  const f = await fixture(t)
  const job = await f.ask('', { kind: 'images', silent: '1' })
  await f.request('/job')
  const result = await f.result({ id: job.id, status: 'ok', images: Array.from({ length: 5 }, () => ({ dataUrl: picture })) })
  assert.equal(result.body.count, 5)
  assert.equal(f.sent.length, 4)
  assert.equal((await f.status(job.id)).meta.images, 5)
  assert.equal(await fs.readFile(path.join(f.ws, '.gpt-relay', 'media', job.id, 'img-5.png'), 'utf8'), 'test-image')
  for (const kind of ['probe', 'dryrun']) {
    const diagnostic = await f.ask('', { kind })
    await f.request('/job')
    const response = await f.result({ id: diagnostic.id, status: 'ok', value: { kind } })
    assert.deepEqual(JSON.parse(await fs.readFile(response.body.file, 'utf8')), { kind })
  }
  assert.equal(f.sent.length, 4)
})

test('status becomes done before delivery finishes, but result HTTP waits for delivery', { timeout: 10_000 }, async t => {
  let releaseSend
  let enterSend
  const blocked = new Promise(resolve => { releaseSend = resolve })
  const entered = new Promise(resolve => { enterSend = resolve })
  const f = await fixture(t, {}, { onSend: async () => { enterSend(); await blocked } })
  const job = await f.ask('delivery timing')
  await f.request('/job')
  let resultFinished = false
  const pending = f.result({ id: job.id, status: 'ok', markdown: 'answer' }).then(value => {
    resultFinished = true
    return value
  })
  try {
    await entered
    const status = await f.status(job.id)
    assert.equal(status.status, 'done')
    assert.equal(status.delivery.status,'pending')
    assert.equal(status.markdown, 'answer')
    assert.equal(status.answerFile, '')
    assert.equal((await f.request('/health')).body.active, null)
    assert.equal(resultFinished, false)
  } finally {
    releaseSend()
  }
  assert.equal((await pending).status, 200)
  assert.ok((await f.status(job.id)).answerFile)
  const delivery=(await f.status(job.id)).delivery
  assert.equal(delivery.status,'partial')
  assert.equal(delivery.screenshotSent,false)
  assert.equal(delivery.screenshotError,'capture-missing')
})
