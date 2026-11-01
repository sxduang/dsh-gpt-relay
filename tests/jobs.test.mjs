import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createJobQueue } from '../relay/core/jobs.mjs'

function fixture(t) {
  // Fake only timers: async filesystem reads still use the real event loop.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sent = []
  const logs = []
  const queue = createJobQueue({
    config: { jobTimeoutSec: 360, queueHintSec: 45, selectors: {} },
    threads: {}, log: (...args) => logs.push(args),
    sendWechat: async text => { sent.push(text); return { code: 0, stderr: '' } },
    getLastTabSeen: () => ({ url: 'https://chatgpt.com/', at: 123 }),
  })
  t.after(() => queue.close())
  const create = (question, options = {}) => queue.createJob({
    kind: 'dump', question, ws: os.tmpdir(), session: null, newChat: false, ...options,
  })
  return { queue, create, sent, logs }
}

test('queued job emits one 45-second hint and becomes no-tab at the original 360-second deadline', async t => {
  const { queue, create, sent, logs } = fixture(t)
  const job = await create('无人领取', { silent: true })
  t.mock.timers.tick(44_999)
  assert.equal(sent.length, 0)
  assert.equal(job.status, 'queued')
  t.mock.timers.tick(1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /没等到 Chrome 里的 GPT 页面来领取/)
  assert.deepEqual(logs.find(entry => entry[0] === 'job still queued')[1].tabSeen,
    { url: 'https://chatgpt.com/', at: 123 })
  t.mock.timers.tick(314_999)
  assert.equal(job.status, 'queued')
  t.mock.timers.tick(1)
  assert.equal(job.status, 'failed')
  assert.equal(job.error, 'no-tab')
  assert.equal(job.detail, '超过 360s 没有完成')
  assert.equal(sent.length, 2)
  assert.equal(sent[1], '⚠️ GPT 中转超时：超过 360s 没有完成\n问题：无人领取')
  assert.equal(queue.takeJob('tab'), null)
  assert.equal(queue.queued, 0)
  t.mock.timers.tick(360_000)
  assert.equal(sent.length, 2)
})

test('running timeout clears active ownership and permits the next queued job', async t => {
  const { queue, create, sent } = fixture(t)
  const first = await create('first')
  assert.equal(queue.takeJob('first-tab'), first)
  t.mock.timers.tick(359_000)
  assert.equal(first.status, 'running')
  assert.equal(sent.length, 0, 'a running job must not emit the unclaimed hint')
  const second = await create('second')
  assert.equal(queue.takeJob('other-tab'), null)
  t.mock.timers.tick(1_000)
  assert.equal(first.status, 'failed')
  assert.equal(first.error, 'timeout')
  assert.equal(queue.activeId, null)
  assert.equal(second.status, 'queued')
  assert.equal(queue.takeJob('second-tab'), second)
  assert.equal(queue.activeId, second.id)
  assert.equal(sent.length, 1)
})

test('result release cancels both timers rather than relying on terminal status checks', async t => {
  const { queue, create, sent } = fixture(t)
  const queued = await create('released while queued')
  queue.releaseJob(queued)
  t.mock.timers.tick(400_000)
  // Intentionally retain queued status so a leaked timer would fail this test.
  assert.equal(queued.status, 'queued')
  assert.equal(sent.length, 0)
  assert.equal(queue.takeJob('tab'), queued)
  queue.releaseJob(queued)
  assert.equal(queue.activeId, null)
  const running = await create('released while running')
  assert.equal(queue.takeJob('tab'), running)
  queue.releaseJob(running)
  t.mock.timers.tick(400_000)
  assert.equal(running.status, 'running')
  assert.equal(queue.activeId, null)
  assert.equal(sent.length, 0)
})

test('concurrent creation retains FIFO order across asynchronous workspace brief reads', async t => {
  const { queue, create } = fixture(t)
  const missingWorkspace = path.join(os.tmpdir(), `gpt-relay-missing-${randomUUID()}`)
  // The first ask yields on stat(); diagnostics need no filesystem access.
  // Without serialization, second/third can be enqueued before first.
  const pending = [
    create('first', { kind: 'ask', ws: missingWorkspace }),
    create('second'),
    create('third'),
  ]
  const jobs = await Promise.all(pending)
  assert.deepEqual([...queue.jobs.values()].map(job => job.question), ['first', 'second', 'third'])
  assert.equal(jobs[0].text, 'first')
  for (const expected of jobs) {
    assert.equal(queue.takeJob('tab'), expected)
    queue.releaseJob(expected)
    expected.status = 'done'
  }
  assert.equal(queue.takeJob('tab'), null)
})
