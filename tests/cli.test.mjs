import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../relay/relay.mjs', import.meta.url))

test('CLI waits for delivery completion before confirming screenshot sending',async t=>{
  let polls=0
  const f=await fixture(t,{status:'done',chars:2,markdown:'答案',get delivery(){return ++polls===1?{status:'pending'}:{status:'complete',screenshotSent:true}}})
  const {stdout}=await f.run(['ask','问题','--wait','4'])
  assert.ok(polls>=2)
  assert.match(stdout,/\[截图已发送\]/)
  assert.doesNotMatch(stdout,/截图未确认发送/)
})

test('CLI reports a missing screenshot instead of claiming all images were sent',async t=>{
  const f=await fixture(t,{status:'done',chars:2,markdown:'答案',delivery:{status:'partial',screenshotSent:false,screenshotError:'answer-layout-unstable-after-retries'}})
  const {stdout}=await f.run(['ask','问题','--wait','2'])
  assert.match(stdout,/截图未确认发送/)
  assert.match(stdout,/answer-layout-unstable-after-retries/)
  assert.doesNotMatch(stdout,/\[截图已发送\]/)
})

test('CLI encodes repeated image paths into a single JSON ask after capability check', async t => {
  const f = await fixture(t)
  const data = Buffer.from([137,80,78,71,13,10,26,10,1])
  await fs.writeFile(path.join(f.root, '图 1.png'), data)
  await fs.writeFile(path.join(f.root, '图2.png'), data)
  await f.run(['ask', '比较图片', '--image', '图 1.png', '--image', '图2.png', '--wait', '0'])
  assert.equal(f.calls[0].url.pathname, '/health')
  const body = JSON.parse(f.calls[1].body)
  assert.equal(body.question, '比较图片')
  assert.deepEqual(body.images.map(image => image.name), ['图 1.png', '图2.png'])
  assert.equal(body.images[0].data, data.toString('base64'))
})

test('old worker blocks image submission and a missing path gives an actionable error', async t => {
  const f = await fixture(t, undefined, false)
  await fs.writeFile(path.join(f.root, 'a.png'), Buffer.from([137,80,78,71,13,10,26,10,1]))
  await assert.rejects(f.run(['ask', '--image', 'a.png', '--wait', '0']), error => /请先重启/.test(error.stderr))
  assert.equal(f.calls.length, 1)
  await assert.rejects(f.run(['ask', '--image']), error => /路径/.test(error.stderr))
  assert.equal(f.calls.length, 1)
})

async function fixture(t, status = { status: 'done', chars: 2, markdown: '答案', answerFile: 'saved.md' }, supportsImages = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-relay-cli-test-'))
  await fs.mkdir(path.join(root, 'relay'))
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const url = new URL(req.url, 'http://127.0.0.1')
    calls.push({ url, body, method: req.method })
    const result = url.pathname === '/ask' || url.pathname === '/resume'
      ? { ok: true, job: { id: 'test-job' }, ws: url.searchParams.get('ws') }
      : url.pathname === '/status' ? { ok: true, id: 'test-job', ...status } : { ok: true, mock: true, capabilities: supportsImages ? { imageUpload: 1, uploadResume:1 } : {} }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  await fs.writeFile(path.join(root, 'relay', 'config.json'), JSON.stringify({
    port: server.address().port, token: 'test-token', jobTimeoutSec: 60, queueHintSec: 60,
    chunkChars: 1400, selectors: {},
  }))
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await fs.rm(root, { recursive: true, force: true })
  })
  const run = args => exec(process.execPath, [cli, ...args], {
    cwd: root, env: { ...process.env, GPT_RELAY_ROOT: root, DSH_SESSION_ID: 'environment-session' },
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  })
  return { root, calls, run }
}

test('CLI ask preserves cwd, session override and flags without polling when wait is zero', async t => {
  const f = await fixture(t)
  const { stdout } = await f.run(['ask', '你好', '世界', '--session', 'explicit-session', '--new', '--silent', '--wait', '0'])
  assert.deepEqual(JSON.parse(stdout), { ok: true, id: 'test-job', ws: f.root })
  assert.equal(f.calls.length, 1)
  const { url, body, method } = f.calls[0]
  assert.equal(method, 'POST')
  assert.equal(body, '你好 世界')
  assert.equal(url.searchParams.get('ws'), f.root)
  assert.equal(url.searchParams.get('session'), 'explicit-session')
  assert.equal(url.searchParams.get('new'), '1')
  assert.equal(url.searchParams.get('silent'), '1')
  assert.equal(url.searchParams.get('token'), 'test-token')
})

test('CLI running is not failure, paused instructs resume, and resume never creates another ask',async t=>{
  const running=await fixture(t,{status:'running',phase:'uploading'})
  const pending=await running.run(['ask','问题','--wait','0.1'])
  assert.match(pending.stdout,/仍在处理/)
  assert.doesNotMatch(pending.stdout,/失败：/)
  const paused=await fixture(t,{status:'paused',error:'upload-pending'})
  assert.match((await paused.run(['ask','问题','--wait','2'])).stdout,/resume test-job/)
  paused.calls.length=0
  await paused.run(['resume','test-job','--wait','0'])
  assert.deepEqual(paused.calls.map(call=>call.url.pathname),['/health','/resume'])
})

test('CLI successful ask uses environment session and prints exact no-redrawing instruction', async t => {
  const f = await fixture(t)
  const { stdout } = await f.run(['ask', '你好', '--wait', '2'])
  assert.equal(f.calls[0].url.searchParams.get('session'), 'environment-session')
  assert.match(stdout, /--- GPT 的回答（2 字）---\n答案/)
  assert.match(stdout, /已存：saved\.md/)
  assert.ok(stdout.includes('不要评论 GPT 配图的有无，也不要自己生成或补画任何图。'))
  assert.ok(stdout.includes('[截图未确认发送]'))
  assert.ok(!stdout.includes('[截图已发送]'))
})

test('CLI log reads relocated project and empty ask exits nonzero without HTTP calls', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'relay', 'relay.log'), 'first\nsecond\nthird\n')
  const { stdout } = await f.run(['log', '2'])
  assert.equal(stdout.trim(), 'second\nthird')
  await assert.rejects(f.run(['ask']), error => error.code === 1 && /用法：ask/.test(error.stderr))
  assert.equal(f.calls.length, 0)
})
