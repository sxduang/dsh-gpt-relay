import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildExtension } from '../scripts/build-extension.mjs'
import { tableToMd } from '../extension/src/content/extract.mjs'
import { usableImage } from '../extension/src/content/images.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const background = await fs.readFile(new URL('../extension/background.js', import.meta.url), 'utf8')
const content = await fs.readFile(new URL('../extension/content.js', import.meta.url), 'utf8')
// relay/config.json is the developer's local file and is not committed, so a
// clean clone must fall back to the same defaults as the build script.
const config = await fs.readFile(new URL('../relay/config.json', import.meta.url), 'utf8')
  .then(JSON.parse)
  .catch(error => {
    if (error.code !== 'ENOENT') throw error
    return { port: 8123, token: '' }
  })
// Checked-in bundles are public builds with an empty token; a developer build
// bakes in the local token. Tests follow whichever endpoint was baked in.
const baked = (() => {
  const match = /registerMessages\((\{[^}]*\})\)/.exec(background)
  return match ? JSON.parse(match[1]) : { worker: `http://127.0.0.1:${config.port}`, token: config.token }
})()

function backgroundHarness({ endpoint = null } = {}) {
  let listener
  const calls=[]
  const page=vm.createContext({window:{},document:{querySelector:()=>null}})
  const context=vm.createContext({
    setTimeout:callback=>{callback();return 1}, URLSearchParams,
    fetch:async(url,options)=>{calls.push({fetch:url,options});return {ok:true,json:async()=>({job:{id:'job-1'}})}},
    chrome:{runtime:{onMessage:{addListener(fn){listener=fn}}},debugger:{
      async attach(target){calls.push({attach:target})},async detach(target){calls.push({detach:target})},
      async sendCommand(target,command,params){calls.push({command,params});if(command==='Runtime.evaluate')return {result:{value:vm.runInContext(params.expression,page)}};return {}},
    }, ...(endpoint ? { storage: { local: { get: async () => ({ endpoint }) }, onChanged: { addListener() {} } } } : {})},
  })
  vm.runInContext(background,context)
  return {calls,message:(message,sender={tab:{id:9}})=>new Promise(resolve=>assert.equal(listener(message,sender,resolve),true))}
}
test('checked-in extension bundles match their source modules and configuration', async () => {
  assert.deepEqual(await buildExtension({ check: true }), ['content.js', 'background.js', 'manifest.json', 'options.html', 'options.js'])
  const manifest = JSON.parse(await fs.readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.background.service_worker, 'background.js')
  assert.equal(manifest.background.type, undefined)
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js'])
  assert.equal(manifest.options_ui.page, 'options.html')
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'))
  assert.ok(manifest.host_permissions.includes('http://localhost/*'))
})

test('port and token changes rebuild the endpoint and host permission together', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-extension-'))
  try {
    await fs.cp(path.join(root, 'extension', 'src'), path.join(temporary, 'extension', 'src'), { recursive: true })
    await fs.mkdir(path.join(temporary, 'relay'))
    await fs.writeFile(path.join(temporary, 'relay', 'config.json'), JSON.stringify({ port: 9876, token: 'test-token' }))
    await buildExtension({ root: temporary })
    const generated = await fs.readFile(path.join(temporary, 'extension', 'background.js'), 'utf8')
    const manifest = JSON.parse(await fs.readFile(path.join(temporary, 'extension', 'manifest.json'), 'utf8'))
    assert.ok(generated.includes('http://127.0.0.1:9876'))
    assert.ok(generated.includes('test-token'))
    assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'))
    await fs.appendFile(path.join(temporary, 'extension', 'content.js'), '\n// stale')
    await assert.rejects(buildExtension({ root: temporary, check: true }), /Stale extension\/content.js/)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
})

test('content script registers one polling loop and one hello even after reinjection', () => {
  const messages = []
  const intervals = []
  const timeouts = []
  const context = vm.createContext({
    window: {}, location: { href: 'https://chatgpt.com/c/example' },
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
    chrome: { runtime: { sendMessage: message => { messages.push(message); return Promise.resolve({}) } } },
  })
  vm.runInContext(content, context)
  vm.runInContext(content, context)
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 2000)
  assert.equal(timeouts.length, 1)
  assert.equal(timeouts[0].ms, 600)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].type, 'hello')
})

test('a mapped conversation saves the pending job before navigating and does not send it twice', async () => {
  const messages = []
  const storage = new Map()
  let poll
  const location = { href: 'https://chatgpt.com/c/current', pathname: '/c/current' }
  const job = { id: 'navigate-1', kind: 'ask', text: '继续这个话题', conversationUrl: 'https://chatgpt.com/c/mapped', selectors: { composer: '#editor' }, attachments: [{ name: 'photo.png', type: 'image/png', size: 123 }] }
  const context = vm.createContext({
    window: {}, location, URL,
    document:{querySelector:()=>null,querySelectorAll:()=>[]},
    sessionStorage: { setItem: (key, value) => storage.set(key, value) },
    setInterval: fn => { poll = fn }, setTimeout() {},
    chrome: { runtime: { async sendMessage(message) { messages.push(message); return message.type === 'poll' ? { ok: true, job } : {} } } },
  })
  vm.runInContext(content, context)
  await poll()
  assert.equal(location.href, job.conversationUrl)
  const pending = JSON.parse(storage.get('__gptRelayResume'))
  assert.equal(pending.id, job.id)
  assert.equal(pending.text, job.text)
  assert.deepEqual(pending.selectors, job.selectors)
  assert.deepEqual(pending.attachments, job.attachments)
  assert.equal(messages.filter(message => message.type === 'result').length, 0)
})

test('navigation recovery discards expired jobs before polling for new work', async () => {
  const storage = new Map([['__gptRelayResume', JSON.stringify({ id: 'old-job', ts: Date.now() - 301000 })]])
  const messages = []
  let startup
  const context = vm.createContext({
    window: {}, location: { href: 'https://chatgpt.com/c/mapped' },
    sessionStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
    setInterval() {}, setTimeout: fn => { startup = fn },
    chrome: { runtime: { async sendMessage(message) { messages.push(message); return { ok: true, job: null } } } },
  })
  vm.runInContext(content, context)
  await startup()
  assert.equal(storage.has('__gptRelayResume'), false)
  assert.equal(messages.filter(message => message.type === 'poll').length, 1)
  assert.equal(messages.filter(message => message.type === 'result').length, 0)
})

test('background forwards poll URL and result payload through the configured endpoint', async () => {
  const bridge = backgroundHarness()
  const poll = await bridge.message({ type: 'poll', url: 'https://chatgpt.com/c/test?a=1&b=2' })
  assert.equal(poll.job.id, 'job-1')
  const url = new URL(bridge.calls[0].fetch)
  assert.equal(url.port, String(config.port))
  assert.equal(url.searchParams.get('token'), baked.token)
  assert.equal(url.searchParams.get('uploads'), '1')
  assert.equal(url.searchParams.get('tab'), 'https://chatgpt.com/c/test?a=1&b=2')
  await bridge.message({ type: 'result', payload: { id: 'job-1', markdown: '结果' } })
  assert.equal(bridge.calls[1].options.method, 'POST')
  assert.deepEqual(JSON.parse(bridge.calls[1].options.body), { id: 'job-1', markdown: '结果' })
})

test('a stored pairing code overrides the baked-in worker and token', async () => {
  const bridge = backgroundHarness({ endpoint: { worker: 'http://127.0.0.1:9999', token: 'abc123abc123abc1' } })
  await bridge.message({ type: 'poll', url: 'https://chatgpt.com/c/test' })
  const url = new URL(bridge.calls[0].fetch)
  assert.equal(url.port, '9999')
  assert.equal(url.searchParams.get('token'), 'abc123abc123abc1')
})

test('attachment bridge checks the sender and requests only the job image endpoint', async () => {
  const bridge = backgroundHarness()
  const denied = await bridge.message({ type: 'attachment', id: 'job-1', index: 0 })
  assert.equal(denied.ok, false)
  assert.equal(bridge.calls.length, 0)
  await bridge.message({ type: 'attachment', id: 'job-1', index: 1 }, { url: 'https://chatgpt.com/c/example', tab: { id: 9 } })
  const url = new URL(bridge.calls[0].fetch)
  assert.equal(url.pathname, '/attachment')
  assert.equal(url.searchParams.get('id'), 'job-1')
  assert.equal(url.searchParams.get('index'), '1')
  assert.equal(url.searchParams.get('token'), baked.token)
})

test('background advertises resume only when the page script also implements it',async()=>{
  const bridge=backgroundHarness()
  await bridge.message({type:'poll',url:'https://chatgpt.com/c/test'})
  assert.equal(new URL(bridge.calls[0].fetch).searchParams.get('resume'),'0')
  await bridge.message({type:'poll',url:'https://chatgpt.com/c/test',uploadResume:1})
  assert.equal(new URL(bridge.calls[1].fetch).searchParams.get('resume'),'1')
})

test('capture requires an exact answer anchor instead of silently using the last message',async()=>{
  const bridge=backgroundHarness()
  const result=await bridge.message({type:'capture',rect:{selector:'[data-assistant]'}})
  assert.equal(result.ok,false)
  assert.equal(result.error,'missing-answer-anchor')
  assert.equal(bridge.calls.length,0)
})

test('a lost answer anchor reports failure and detaches without capturing another turn',async()=>{
  const bridge=backgroundHarness()
  const result=await bridge.message({type:'capture',rect:{selector:'[data-gpt-relay-answer="job-1"]'}})
  assert.equal(result.ok,false)
  assert.equal(result.error,'answer-anchor-lost')
  assert.ok(bridge.calls.some(call=>call.detach))
  assert.ok(!bridge.calls.some(call=>call.command==='Page.captureScreenshot'))
})
test('table extraction preserves columns, multiline cells and short-row padding', () => {
  const table = { querySelectorAll: () => [['指标', '值'], ['A\n B', '12'], ['缺项']].map(row => ({ querySelectorAll: () => row.map(innerText => ({ innerText })) })) }
  assert.equal(tableToMd(table), '| 指标 | 值 |\n| --- | --- |\n| A B | 12 |\n| 缺项 |  |')
})

test('image extraction excludes small avatars and favicons but keeps full-size answer images', () => {
  const img = (src, naturalWidth) => ({ src, naturalWidth, dataset: {} })
  assert.equal(usableImage(img('https://example.com/answer.png', 120)), true)
  assert.equal(usableImage(img('https://example.com/answer.png', 119)), false)
  assert.equal(usableImage(img('https://example.com/avatar.png', 300)), false)
  assert.equal(usableImage(img('https://example.com/favicon.png', 300)), false)
  assert.equal(usableImage(img('', 300)), false)
})

