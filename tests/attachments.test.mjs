import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { validateAttachments, MAX_IMAGE_BYTES } from '../relay/core/attachments.mjs'
import { readBody } from '../relay/http.mjs'
import { uploadAttachments, waitAttachments, attachmentState } from '../extension/src/content/attachments.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64')

test('attachment validation detects image bytes and rejects invalid format, count and size', () => {
  const images = validateAttachments([{ name: 'a.txt', data: png.toString('base64') }])
  assert.equal(images[0].type, 'image/png')
  assert.equal(images[0].name, 'a.png')
  assert.throws(() => validateAttachments([{ data: Buffer.from('<svg/>').toString('base64') }]), /格式不支持/)
  assert.throws(() => validateAttachments([{ data: '****' }]), /base64/)
  assert.throws(() => validateAttachments(Array(5).fill({})), /4 张/)
  assert.throws(() => validateAttachments([{ data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }]), /10 MiB/)
})

test('HTTP reader preserves split UTF-8 and rejects oversized bodies instead of hanging', async () => {
  const request = new PassThrough()
  const reading = readBody(request, 6)
  const text = Buffer.from('你好')
  request.write(text.subarray(0, 1)); request.end(text.subarray(1))
  assert.equal(await reading, '你好')
  const oversized = new PassThrough()
  const rejected = assert.rejects(readBody(oversized, 3), error => error.statusCode === 413)
  oversized.end('1234')
  await rejected
})

function page(t, { paste = false, error = false, noPreview = false, existing = false } = {}) {
  const globals = ['DataTransfer', 'ClipboardEvent', 'chrome']
  const previous = Object.fromEntries(globals.map(key => [key, globalThis[key]]))
  t.after(() => { for (const key of globals) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key] } })
  let clock = 0, count = existing ? 1 : 0, started = false
  const fetched = []
  const input = { accept: 'image/*', multiple: true, dispatchEvent() { started = true } }
  const scope = {
    querySelectorAll(selector) {
      if (selector === 'img') return Array.from({ length: count }, () => ({ src: 'blob:preview' }))
      if (selector === 'input[type="file"]') return paste ? [] : [input]
      if (selector.includes('alert')) return error && started ? [{ textContent: '上传失败' }] : []
      return []
    },
    querySelector(selector) { return selector==='[data-composer-attachments]' ? null : started && clock < 600 ? {} : null },
  }
  let pasted
  const composer = { closest: () => scope, focus() {}, dispatchEvent(event) { started = true; pasted = event.clipboardData.files } }
  globalThis.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) } }
  }
  globalThis.ClipboardEvent = class { constructor(type, props) { Object.assign(this, props) } }
  globalThis.chrome = { runtime: { async sendMessage(msg) { fetched.push(msg); return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` } } } }
  const job = { id: 'job', attachments: ['one.png', 'two.png'].map(name => ({ name, type: 'image/png', size: png.length })) }
  const options = { now: () => clock, timeoutMs: 2400, sleep: async ms => { clock += ms; if (started && !noPreview) count = 2 }, findSend: () => ({ disabled: clock < 600, getAttribute: () => null }) }
  return { job, composer, options, input, fetched, clock: () => clock, pasted: () => pasted }
}

test('two image files attach together and wait for completed previews and enabled send', async t => {
  const f = page(t)
  await uploadAttachments(f.job, f.composer, {}, f.options)
  assert.deepEqual(f.input.files.map(file => file.name), ['one.png', 'two.png'])
  assert.deepEqual(Buffer.from(await f.input.files[0].arrayBuffer()), png)
  assert.equal(f.fetched.length, 2)
  assert.ok(f.clock() >= 1800)
})

test('composer paste supports pages without a mounted file input', async t => {
  const f = page(t, { paste: true })
  await uploadAttachments(f.job, f.composer, {}, f.options)
  assert.equal(f.pasted().length, 2)
})

test('failed upload rejects without triggering a send', async t => {
  const f = page(t, { error: true })
  await assert.rejects(uploadAttachments(f.job, f.composer, {}, f.options), /上传失败/)
})

test('missing previews time out rather than sending text alone', async t => {
  const f = page(t, { noPreview: true })
  await assert.rejects(uploadAttachments(f.job, f.composer, {}, f.options), error=>error.code==='upload-pending')
})

test('resume waits on existing attachments and a replacement composer without uploading again',async t=>{
  const f=page(t,{existing:true})
  const job={...f.job,attachments:f.job.attachments.slice(0,1)}
  let reads=0
  const result=await waitAttachments(job,f.composer,{}, {...f.options,getComposer:()=>{reads++;return f.composer}})
  assert.equal(result,f.composer)
  assert.ok(reads>1)
  assert.equal(f.fetched.length,0)
  assert.equal(f.input.files,undefined)
})

test('an undecoded thumbnail is not ready; unrelated busy controls are excluded',()=>{
  const image={src:'blob:one',complete:false,naturalWidth:0}
  const area={querySelectorAll:()=>[image],querySelector:()=>null}
  const form={querySelector:sel=>sel==='[data-composer-attachments]'?area:{},querySelectorAll:()=>[]}
  const composer={closest:()=>form}
  assert.equal(attachmentState(composer,{}).busy,true)
  image.complete=true;image.naturalWidth=400
  assert.equal(attachmentState(composer,{}).busy,false)
})

test('existing draft attachment is left untouched', async t => {
  const f = page(t, { existing: true })
  await assert.rejects(uploadAttachments(f.job, f.composer, {}, f.options), /已有附件/)
  assert.equal(f.fetched.length, 0)
})
