import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { buildDeliveryPlan, createDelivery, wechatReason } from '../relay/core/delivery.mjs'

const screenshot = 'data:image/png;base64,c2hvdA=='
const baseJob = { id: 'abc', ws: path.join('workspace', 'demo'), createdAt: 1000, meta: {} }
const plan = (markdown, meta = {}, extra = {}) => buildDeliveryPlan({
  job: { ...baseJob, meta }, markdown, screenshot, chunkChars: 1400, now: 3000, ...extra,
})

test('short plain answers also send their screenshot', () => {
  const result = plan('**你好**')
  assert.equal(result.wantsShot, true)
  assert.equal(result.link, '')
  assert.deepEqual(result.messages, [{text:'【GPT 回答·2s·demo】',file:'screenshot'},{ text: '（文字版）\n你好' }])
})

test('table screenshot precedes text even when the answer also has original images', () => {
  const result = plan('内容', { rich: { tables: 1 } })
  assert.equal(result.wantsShot, true)
  assert.deepEqual(result.messages, [
    { text: '【GPT 回答·2s·demo】', file: 'screenshot' },
    { text: '（文字版）\n内容' },
  ])
  assert.equal(plan('内容', { rich: { images: 1, tables: 1 } }).wantsShot, true)
  assert.equal(plan('内容', { rich: { tables: 1 } }, { screenshot: 'invalid' }).wantsShot, false)
})

test('long-answer threshold is strictly 500 characters; canvas always gets a URL', () => {
  const meta = { url: 'https://chatgpt.com/c/example' }
  assert.equal(plan('字'.repeat(500), meta).wantsShot, true)
  assert.equal(plan('字'.repeat(500), meta).link, '')
  assert.equal(plan('字'.repeat(501), meta).wantsShot, true)
  assert.equal(plan('字'.repeat(501), meta).link, '🔗 网页原文：https://chatgpt.com/c/example')
  const canvas = plan('交互图', { ...meta, rich: { canvas: 1 } })
  assert.equal(canvas.wantsShot, true)
  assert.equal(canvas.link, '🔗 网页原文：https://chatgpt.com/c/example')
})

test('two to four chunks preserve continuation labels and 800ms gaps', () => {
  assert.deepEqual(plan('abcdef', {}, { chunkChars: 2, screenshot:null }).messages, [
    { text: '【GPT 回答·2s·demo】\nab', delayAfter: 800 },
    { text: '（续 2/3）\ncd', delayAfter: 800 },
    { text: '（续 3/3）\nef', delayAfter: 800 },
  ])
})

test('more than four chunks send three excerpts followed by the full Markdown file', () => {
  const result = plan('abcdefghij', {}, { chunkChars: 2, screenshot:null })
  assert.equal(result.chunks.length, 5)
  assert.deepEqual(result.messages, [
    { text: '【GPT 回答·2s·demo】\nab', delayAfter: 800 },
    { text: '（续 2/3）\ncd', delayAfter: 800 },
    { text: '（续 3/3）\nef', delayAfter: 800 },
    { text: '……全文 10 字，完整版见文件。', file: 'answer' },
  ])
})

test('overlay explanation is prepended after chunking and only to the first chunk', () => {
  const result = plan('abcdef', { overlay: { action: 'chose', label: '以后再说' } }, { chunkChars: 3, screenshot:null })
  assert.equal(result.messages[0].text, '【GPT 回答·2s·demo】\n（页面弹窗我替你选了「以后再说」，可在网页里改）\nabc')
  assert.equal(result.messages[1].text, '（续 2/2）\ndef')
  assert.equal(plan('', { overlay: { action: 'chose', label: '确定' } }).messages.length, 1)
})

function harness(imageCount = 5, screenshotCode = 0, textCode = 0) {
  const events = []
  const storage = {
    scopeBase: async () => 'answers',
    mediaBase: async () => 'media',
    writeText: async (file, text) => events.push(['write', file, text]),
    journal: async (job, text) => events.push(['journal', job.id, text]),
    writeDataUrl: async (file, data) => events.push(['shot', file, data]),
    saveImages: async () => { events.push(['save-images']); return Array.from({ length: imageCount }, (_, i) => `img-${i}.png`) },
  }
  const deliver = createDelivery({
    config: { chunkChars: 1400 }, storage,
    sendWechat: async (...args) => { events.push(['send', ...args]);return {code:/answer(?:-\d+)?\.png$/.test(args[1] || '')?(typeof screenshotCode==='function'?screenshotCode(args[1]):screenshotCode):(typeof textCode==='function'?textCode(args[0]):textCode)} },
    sleep: async (ms) => events.push(['sleep', ms]),
  })
  return { events, deliver, storage }
}

test('a WeChat failure carries a reason the agent can act on, not a bare exit code',async()=>{
  assert.equal(wechatReason(0),'ok')
  assert.equal(wechatReason(2),'no-wechat-conversation-bound')
  assert.equal(wechatReason(3),'wechat-window-closed')
  assert.equal(wechatReason(1),'wechat-send-failed')
  const {deliver}=harness(0,0,3)
  const result=await deliver(baseJob,'正文',[],null)
  assert.equal(result.wechatError.code,3)
  assert.equal(result.wechatError.reason,'wechat-window-closed')
})

test('executor saves raw Markdown and preserves screenshot, text, up to four images, link order', async () => {
  const { events, deliver } = harness()
  const result = await deliver({ ...baseJob, meta: { rich: { tables: 1, canvas: 1 }, url: 'https://chatgpt.com/c/example' } }, '**正文**', [], screenshot)
  assert.deepEqual(events.slice(0, 3), [
    ['write', path.join('answers', 'abc.md'), '**正文**'],
    ['journal', 'abc', '**正文**'],
    ['shot', path.join('media', 'answer.png'), screenshot],
  ])
  const sends = events.filter(([type]) => type === 'send')
  assert.equal(sends[0][2], path.join('media', 'answer.png'))
  assert.deepEqual(sends.slice(1), [
    ['send', '（文字版）\n正文'],
    ['send', '', 'img-0.png'], ['send', '', 'img-1.png'],
    ['send', '', 'img-2.png'], ['send', '', 'img-3.png'],
    ['send', '🔗 网页原文：https://chatgpt.com/c/example'],
  ])
  assert.deepEqual(events.filter(([type]) => type === 'sleep'), Array(4).fill(['sleep', 600]))
  assert.equal(result.screenshotSent,true)
  assert.equal(result.screenshotError,'')
  assert.deepEqual(result.errors,[])
  assert.equal(result.images,5)
})

test('silent compatibility saves eligible screenshot, skips original images and all sends', async () => {
  const { events, deliver } = harness()
  const result = await deliver({ ...baseJob, silent: true, meta: { rich: { tables: 1 } } }, '正文', [], screenshot)
  assert.deepEqual(events.map(([type]) => type), ['write', 'journal', 'shot'])
  assert.equal(result.screenshotSent,false)
  assert.equal(result.silent,true)
  assert.equal(result.shot,true)
})

test('a failed screenshot send is reported accurately and does not suppress answer text',async()=>{
  const {events,deliver}=harness(0,1)
  const result=await deliver(baseJob,'正文',[],screenshot)
  assert.equal(result.shot,true)
  assert.equal(result.screenshotSent,false)
  assert.equal(result.screenshotError,'screenshot-send-failed')
  const sends=events.filter(([type])=>type==='send')
  assert.equal(sends.length,2)
  assert.match(sends[1][1],/截图未能送达/)
  assert.match(sends[1][1],/正文/)
})

test('capture failure warns in the first text message instead of silently omitting the screenshot',async()=>{
  const {events,deliver}=harness(0)
  const result=await deliver({...baseJob,meta:{screenshotError:'answer-layout-unstable-after-retries'}},'答案',[],null)
  assert.equal(result.screenshotSent,false)
  assert.equal(result.screenshotError,'answer-layout-unstable-after-retries')
  assert.match(events.find(([type])=>type==='send')[1],/截图未能送达/)
})

test('all long screenshots are saved and delivered in order before text, with truthful page counts',async()=>{
  const {events,deliver}=harness(0)
  const pages=[screenshot,screenshot,screenshot]
  const result=await deliver({...baseJob,meta:{screenshotInfo:{pages:3}}},'完整答案',[],null,pages)
  const sends=events.filter(([type])=>type==='send')
  assert.equal(sends.length,4)
  for(let i=0;i<3;i++) {
    assert.match(sends[i][1],new RegExp(`截图 ${i+1}/3`))
    assert.equal(sends[i][2],path.join('media',`answer-00${i+1}.png`))
    assert.equal(result.screenshotPages[i].sent,true)
  }
  assert.equal(sends[3][1],'（文字版）\n完整答案')
  assert.equal(result.screenshotCount,3)
  assert.equal(result.screenshotsSent,3)
  assert.equal(result.screenshotSent,true)
  assert.equal(result.screenshotFiles.length,3)
})

test('a missing middle delivery still sends the remaining page but reports partial instead of success',async()=>{
  const {events,deliver}=harness(0,file=>file.endsWith('002.png')?1:0)
  const result=await deliver(baseJob,'答案',[],null,[screenshot,screenshot,screenshot])
  assert.equal(result.screenshotsSent,2)
  assert.equal(result.screenshotSent,false)
  assert.equal(result.screenshotPages[1].error,'screenshot-send-failed')
  assert.equal(result.screenshotPages[2].sent,true)
  assert.match(events.filter(([type])=>type==='send').at(-1)[1],/2\/3 张，未送达：2/)
})

test('silent multi-image capture saves every page without sending; malformed/missing pages cannot be complete',async()=>{
  const {events,deliver}=harness(0)
  const result=await deliver({...baseJob,silent:true},'答案',[],null,[screenshot,screenshot])
  assert.equal(result.screenshotCount,2)
  assert.equal(result.screenshotFiles.length,2)
  assert.equal(events.filter(([type])=>type==='send').length,0)
  const missing=await deliver({...baseJob,meta:{screenshotInfo:{pages:3}}},'答案',[],null,[screenshot,screenshot])
  assert.equal(missing.screenshotSent,false)
  assert.equal(missing.screenshotError,'capture-pages-incomplete')
  const malformed=await deliver(baseJob,'答案',[],null,[screenshot,'invalid'])
  assert.equal(malformed.screenshotSent,false)
  assert.equal(malformed.screenshotError,'capture-pages-invalid')
})

test('a page save failure is surfaced and does not hide other saved pages',async()=>{
  const {storage,events,deliver}=harness(0)
  const write=storage.writeDataUrl
  storage.writeDataUrl=async(file,data)=>{if(file.endsWith('002.png'))throw new Error('disk failed');return write(file,data)}
  const result=await deliver(baseJob,'答案',[],null,[screenshot,screenshot,screenshot])
  assert.equal(result.screenshotSent,false)
  assert.equal(result.screenshotPages[1].error,'screenshot-save-failed')
  assert.equal(result.screenshotPages[2].sent,true)
  assert.equal(events.filter(([type,,file])=>type==='send' && file).length,2)
})
