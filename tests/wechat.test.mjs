import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createWechatSender } from '../relay/adapters/wechat.mjs'

const config = { node: 'dsh-node', wechatCli: 'plugin-cli', dshHome: 'dsh-home' }
const tick = () => new Promise((resolve) => setImmediate(resolve))
function harness() {
  const children = []
  const calls = []
  const logs = []
  const send = createWechatSender({ config, log: (...args) => logs.push(args), spawn: (...args) => {
    calls.push(args)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    children.push(child)
    return child
  } })
  return { children, calls, logs, send }
}

test('WeChat child processes are serial and retain DSH executable, environment and hidden windows', async () => {
  const { children, calls, send } = harness()
  const first = send('第一条', 'answer.png')
  const second = send('第二条')
  await tick()
  assert.equal(children.length, 1)
  assert.equal(calls[0][0], 'dsh-node')
  assert.deepEqual(calls[0][1], ['plugin-cli', '第一条', '--file', 'answer.png'])
  assert.equal(calls[0][2].env.DSH_HOME, 'dsh-home')
  assert.equal(calls[0][2].windowsHide, true)
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe'])
  children[0].emit('close', 0)
  assert.deepEqual(await first, { code: 0, stderr: '' })
  await tick()
  assert.equal(children.length, 2)
  assert.deepEqual(calls[1][1], ['plugin-cli', '第二条'])
  children[1].emit('close', 3)
  assert.deepEqual(await second, { code: 3, stderr: '' })
})

test('spawn error events are reported without blocking the next queued message', async () => {
  const { children, send } = harness()
  const first = send('', 'image.png')
  const second = send('next')
  await tick()
  children[0].emit('error', new Error('spawn failed'))
  assert.deepEqual(await first, { code: -1, stderr: 'Error: spawn failed' })
  children[0].emit('close', -1)
  await tick()
  assert.equal(children.length, 2)
  children[1].emit('close', 0)
  assert.equal((await second).code, 0)
})

test('empty sends do not spawn; stderr logging remains limited to 200 characters', async () => {
  const { children, logs, send } = harness()
  assert.deepEqual(await send('', ''), { code: 2, stderr: 'nothing to send' })
  assert.equal(children.length, 0)
  const pending = send('hello')
  await tick()
  children[0].stderr.emit('data', Buffer.from('x'.repeat(300)))
  children[0].emit('close', 1)
  assert.equal((await pending).stderr.length, 300)
  assert.equal(logs[1][1].stderr.length, 200)
})
