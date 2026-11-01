import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createStorage } from '../relay/adapters/storage.mjs'
import { createThreadStore } from '../relay/adapters/threads.mjs'
import { createLogger } from '../relay/adapters/logger.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-relay-storage-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const ws = path.join(root, 'workspace')
  await fs.mkdir(ws)
  const storage = createStorage({ root })
  await storage.init()
  return { root, ws, storage }
}

test('storage uses workspace/session isolation and retains unscoped fallback for missing workspaces', async (t) => {
  const { root, ws, storage } = await fixture(t)
  assert.equal(await storage.scopeBase({ ws, session: 'one' }), path.join(ws, '.gpt-relay', 'sessions', 'one'))
  assert.equal(await storage.scopeBase({ ws, session: 'two' }), path.join(ws, '.gpt-relay', 'sessions', 'two'))
  assert.equal(await storage.scopeBase({ ws }), path.join(ws, '.gpt-relay'))
  assert.equal(await storage.scopeBase({ ws: path.join(root, 'missing'), session: 'one' }), path.join(root, 'answers'))
  assert.equal(await storage.mediaBase({ ws, session: 'one', id: 'abc' }), path.join(ws, '.gpt-relay', 'sessions', 'one', 'media', 'abc'))
})

test('images retain original indices and MIME extensions and ignore non-data URLs', async (t) => {
  const { ws, storage } = await fixture(t)
  const files = await storage.saveImages({ ws, id: 'abc' }, [
    { dataUrl: 'data:image/jpeg;base64,aGVsbG8=' }, null,
    { dataUrl: 'https://example.org/image.png' }, { dataUrl: 'data:image/svg+xml;base64,c3Zn' },
  ])
  assert.deepEqual(files.map((file) => path.basename(file)), ['img-1.jpg', 'img-4.svg'])
  assert.equal(await fs.readFile(files[0], 'utf8'), 'hello')
  assert.equal(await fs.readFile(files[1], 'utf8'), 'svg')
  assert.deepEqual(await storage.saveImages({ ws, id: 'none' }, null), [])
})

test('journal appends concurrent complete entries without losing existing history', async (t) => {
  const { ws, storage } = await fixture(t)
  const base = await storage.scopeBase({ ws, session: 'one' })
  const file = path.join(base, 'journal.md')
  await fs.writeFile(file, 'old history', 'utf8')
  await Promise.all(Array.from({ length: 20 }, (_, index) => storage.journal({ ws, session: 'one', id: `job-${index}`, question: `问题${index}` }, `答案${index}`)))
  const content = await fs.readFile(file, 'utf8')
  assert.ok(content.startsWith('old history'))
  assert.equal((content.match(/\*\*问：\*\*/g) || []).length, 20)
  for (let i = 0; i < 20; i += 1) assert.ok(content.includes(`**问：** 问题${i}\n\n**答：**\n\n答案${i}\n`))
})

test('write helpers preserve UTF-8, JSON formatting and reject invalid image data without a file', async (t) => {
  const { root, storage } = await fixture(t)
  const file = path.join(root, 'data')
  await storage.writeText(file, '中文原文')
  assert.equal(await fs.readFile(file, 'utf8'), '中文原文')
  await storage.writeJson(file, { answer: '中文' })
  assert.equal(await fs.readFile(file, 'utf8'), '{\n  "answer": "中文"\n}')
  const image = path.join(root, 'image.png')
  assert.equal(await storage.writeDataUrl(image, 'invalid'), false)
  await assert.rejects(fs.access(image), { code: 'ENOENT' })
  assert.equal(await storage.writeDataUrl(image, 'data:image/png;base64,aGk='), true)
  assert.equal(await fs.readFile(image, 'utf8'), 'hi')
})

test('thread saves serialize snapshots, publish valid JSON and keep the exposed map identity', async (t) => {
  const { root } = await fixture(t)
  const file = path.join(root, 'threads.json')
  const store = createThreadStore(file)
  assert.deepEqual(await store.load(), {})
  store.threads.one = { url: 'https://chatgpt.com/c/one', at: 1 }
  const first = store.save()
  store.threads.two = { url: 'https://chatgpt.com/c/two', at: 2 }
  const second = store.save()
  await Promise.all([first, second])
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), store.threads)
  const identity = store.threads
  await store.load()
  assert.equal(store.threads, identity)
  assert.equal(store.threads.two.at, 2)
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), [])
  await fs.writeFile(file, 'broken JSON')
  assert.deepEqual(await store.load(), {})
})

test('logger flush preserves line order and handles a write failure without poisoning later logs', async (t) => {
  const { root } = await fixture(t)
  const file = path.join(root, 'logs', 'relay.log')
  const errors = []
  const log = createLogger(file, { onError: (err) => errors.push(err) })
  log('before directory exists')
  await log.flush()
  assert.equal(errors.length, 1)
  await fs.mkdir(path.dirname(file))
  log('first', { id: 1 })
  log('second', { id: 2 })
  await log.flush()
  const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /first \{"id":1\}$/)
  assert.match(lines[1], /second \{"id":2\}$/)
})
