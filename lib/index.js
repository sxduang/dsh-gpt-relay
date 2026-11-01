// dsh-gpt-relay — Host half.
//
// Starts the local worker in-process, pairs with the bundled Chrome extension,
// and exposes tools so the agent can ask the web ChatGPT page and read back the
// answer plus its full-answer screenshot.
//
// The worker itself is the existing relay/: same HTTP API, same delivery rules.
// Everything machine-specific (port, token, node path, WeChat CLI) lives in
// <DSH_HOME>/gpt-relay/config.json, created on first run.

import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createWorker } from '../relay/worker-app.mjs'
import { createWechatSender } from '../relay/adapters/wechat.mjs'
import { loadImageFiles } from '../relay/core/attachments.mjs'

export const name = 'gpt-relay'
export const inject = ['tools']

/** Package root: the directory that holds relay/, extension/ and cordis.patch.yml. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const DEFAULT_SELECTORS = {
  assistant: '[data-markdown-text-style="assistant-message"]',
  send: 'button[aria-label="发送"]',
  stop: '[data-testid="stop-button"]',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function profileDir() {
  const profile = process.env.DSH_PROFILE || 'desktop'
  return process.env.DSH_PROFILE_DIR || path.join(dshHome(), 'profiles', profile)
}

async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function freePort(preferred) {
  for (let port = preferred; port < preferred + 40; port += 1) {
    if (await canListen(port)) return port
  }
  return 0
}

/** The WeChat CLI must be launched by a real node: inside Electron, process.execPath is the app itself. */
async function findNode(explicit) {
  const looksLikeNode = (value) => /^node(\.exe)?$/i.test(path.basename(String(value || '')))
  const candidates = [explicit, process.env.DSH_NODE, process.execPath].filter(looksLikeNode)
  try {
    for (const name of await fs.readdir(path.join(dshHome(), 'dsh-runtimes'))) {
      candidates.push(path.join(dshHome(), 'dsh-runtimes', name, 'dependencies', 'node', 'bin', 'node.exe'))
      candidates.push(path.join(dshHome(), 'dsh-runtimes', name, 'dependencies', 'node', 'bin', 'node'))
    }
  } catch { /* no runtimes directory */ }
  candidates.push(path.join(dshHome(), '.runtime', 'node', 'node.exe'), path.join(dshHome(), '.runtime', 'node', 'node'))
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate
  }
  return process.execPath
}

/** The WeChat plugin (dsh-wechat-plugin) is optional: without it answers are returned to the agent only. */
async function findWechatCli(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_WECHAT_CLI,
    path.join(profileDir(), 'node_modules', 'dsh-wechat-plugin', 'cli.js'),
    path.join(dshHome(), 'profiles', 'desktop', 'node_modules', 'dsh-wechat-plugin', 'cli.js'),
  ]
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate
  }
  return ''
}

const EXTENSION_FILES = ['background.js', 'content.js', 'manifest.json', 'options.html', 'options.js']
const MATERIALIZED = '.materialized.json'
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * The shipped extension carries no secret. At boot we write a copy into the data
 * directory with this machine's endpoint baked in, so loading that folder just
 * works — and the same package can be published without leaking a token.
 *
 * This copy is generated, not a workspace: an edit made here is overwritten on
 * the next boot, so any local modification is backed up beside it and reported.
 */
export async function materializeExtension(dir, config, log = () => {}) {
  const sourceDir = path.join(PACKAGE_ROOT, 'extension')
  const targetDir = path.join(dir, 'extension')
  await fs.mkdir(targetDir, { recursive: true })
  const recordFile = path.join(targetDir, MATERIALIZED)
  let record = { files: {} }
  try {
    const parsed = JSON.parse(await fs.readFile(recordFile, 'utf8'))
    if (parsed && typeof parsed.files === 'object') record = parsed
  } catch { /* first run, or the record was removed */ }
  const endpoint = JSON.stringify({ worker: `http://127.0.0.1:${config.port}`, token: config.token })
  const next = {}
  let written = 0
  for (const file of EXTENSION_FILES) {
    const source = await fs.readFile(path.join(sourceDir, file), 'utf8')
    const output = file === 'background.js' ? source.replace(/registerMessages\(\{[^}]*\}\)/, `registerMessages(${endpoint})`) : source
    const target = path.join(targetDir, file)
    const current = await fs.readFile(target, 'utf8').catch(() => null)
    const targetHash = sha256(output)
    next[file] = targetHash
    if (current === output) continue
    const currentHash = current === null ? '' : sha256(current)
    const wasOurs = record.files && record.files[file] === currentHash
    if (current !== null && !wasOurs) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
      const backup = `${target}.edited-${stamp}.bak`
      await fs.writeFile(backup, current, 'utf8')
      log(`extension/${file} 有本地修改，已备份到 ${path.basename(backup)} 后重新生成`)
    }
    await fs.writeFile(target, output, 'utf8')
    written += 1
  }
  await fs.writeFile(recordFile, `${JSON.stringify({ source: PACKAGE_ROOT, version: await packageVersion(), writtenAt: new Date().toISOString(), files: next }, null, 2)}\n`, 'utf8')
  if (written) log(`扩展副本已更新 ${written} 个文件 → ${targetDir}`)
  return targetDir
}

let cachedVersion = ''
async function packageVersion() {
  if (cachedVersion) return cachedVersion
  try {
    cachedVersion = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || 'unknown'
  } catch { cachedVersion = 'unknown' }
  return cachedVersion
}

async function ensureRuntimeConfig(options, log) {
  const dir = path.resolve(options.dataDir || path.join(dshHome(), 'gpt-relay'))
  await fs.mkdir(path.join(dir, 'relay'), { recursive: true })
  const file = path.join(dir, 'config.json')
  let previous = null
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')) } catch { previous = null }
  if (!previous) {
    // First run inside the development checkout: inherit relay/config.json so an
    // already-loaded extension keeps working. Published packages ship no such file.
    try { previous = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, 'relay', 'config.json'), 'utf8')) } catch { previous = null }
  }

  const wechatCli = await findWechatCli(options.wechatCli || previous?.wechatCli)
  const node = await findNode(options.node || previous?.node)
  const preferred = Number.isInteger(options.port) ? options.port : (Number.isInteger(previous?.port) ? previous.port : 8123)
  const port = await canListen(preferred) ? preferred : await freePort(preferred + 1)

  const config = {
    port,
    token: typeof previous?.token === 'string' && previous.token ? previous.token : randomBytes(16).toString('hex'),
    node,
    wechatCli: wechatCli || '',
    dshHome: dshHome(),
    conversationUrl: previous?.conversationUrl || 'https://chatgpt.com/',
    jobTimeoutSec: Number.isFinite(options.jobTimeoutSec) ? options.jobTimeoutSec : (previous?.jobTimeoutSec || 600),
    chunkChars: Number.isFinite(options.chunkChars) ? options.chunkChars : (previous?.chunkChars || 1400),
    queueHintSec: Number.isFinite(options.queueHintSec) ? options.queueHintSec : (previous?.queueHintSec || 45),
    selectors: previous?.selectors || DEFAULT_SELECTORS,
  }
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const extensionDir = await materializeExtension(dir, config, log)
  if (!wechatCli) log('dsh-wechat-plugin 未安装：答案只回给 agent，不推微信')
  return { dir, file, config, extensionDir }
}

function sessionOf(exec) {
  try { return exec?.agent?.session } catch { return undefined }
}

function workspaceOf(exec) {
  try {
    const cwd = sessionOf(exec)?.header?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  } catch { /* ignore */ }
  return process.cwd()
}

function sessionIdOf(exec) {
  try {
    const session = sessionOf(exec)
    const id = session?.id || session?.header?.id
    if (typeof id === 'string' && id) return id
  } catch { /* ignore */ }
  return process.env.DSH_SESSION_ID || ''
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
}

function wechatHint(error) {
  if (!error) return ''
  if (error.reason === 'no-wechat-conversation-bound') return '（这台机器上的 dsh-wechat-plugin 还没绑定对话：先在微信里给机器人发一句话）'
  if (error.reason === 'wechat-window-closed') return '（微信这个回复窗口已经用完：你下次发消息后会自动补发，不要重试）'
  if (error.reason === 'wechat-send-failed') return `（发送失败${error.stderr ? `：${error.stderr}` : ''}）`
  return ''
}

function describeStatus(job) {
  if (!job) return '（没有拿到任务状态）'
  const lines = [`任务 ${job.id}：${job.status}${job.phase ? ` / ${job.phase}` : ''}`]
  if (job.error) lines.push(`错误：${job.error}${job.detail ? ` ${job.detail}` : ''}`)
  const delivery = job.delivery || {}
  if (delivery.silent) lines.push('投递：静默（只保存，未发微信）')
  else if (delivery.status === 'pending') lines.push('投递：进行中')
  else if (delivery.screenshotSent) lines.push(`投递：截图 ${delivery.screenshotCount || 1} 张已确认送达`)
  else if (delivery.screenshotError) lines.push(`投递：截图未送达（${delivery.screenshotError}）${wechatHint(delivery.wechatError)}`)
  if (job.answerFile) lines.push(`答案文件：${job.answerFile}`)
  return lines.join('\n')
}

export function apply(ctx, options = {}) {
  const logger = ctx.logger || console
  const log = (message) => {
    try { logger.info(`gpt-relay: ${message}`) } catch { /* ignore */ }
  }
  const state = { app: null, base: '', token: '', config: null, dir: '', booting: null, closed: false }

  async function boot() {
    if (state.app) return state
    if (state.booting) return state.booting
    state.booting = (async () => {
      const runtime = await ensureRuntimeConfig(options, log)
      const sendWechat = runtime.config.wechatCli
        ? createWechatSender({ config: runtime.config, log: (event, detail) => logger.debug?.(`gpt-relay: ${event} ${JSON.stringify(detail)}`) })
        : async () => ({ code: 0, stderr: 'delivery-disabled' })
      const app = await createWorker({ root: runtime.dir, config: runtime.config, sendWechat })
      await new Promise((resolve, reject) => {
        app.server.once('error', reject)
        app.server.listen(runtime.config.port, '127.0.0.1', resolve)
      })
      state.app = app
      state.base = `http://127.0.0.1:${runtime.config.port}`
      state.token = runtime.config.token
      state.config = runtime.config
      state.dir = runtime.dir
      state.extensionDir = runtime.extensionDir
      log(`worker listening ${state.base}${runtime.config.wechatCli ? '' : '（无微信投递）'}`)
      return state
    })().finally(() => { state.booting = null })
    return state.booting
  }

  async function stop() {
    state.closed = true
    const app = state.app
    state.app = null
    if (!app) return
    try { await app.close() } catch (error) { log(`close failed: ${error?.message || error}`) }
  }

  async function api(pathname, init) {
    await boot()
    const separator = pathname.includes('?') ? '&' : '?'
    const response = await fetch(`${state.base}${pathname}${separator}token=${state.token}`, init)
    return response.json()
  }

  async function waitFor(id, seconds) {
    const deadline = Date.now() + Math.max(0, seconds) * 1000
    let last = null
    while (Date.now() < deadline) {
      last = await api(`/status?id=${encodeURIComponent(id)}`)
      if (last.status === 'failed' || last.status === 'paused') return last
      if (last.status === 'done' && last.delivery?.status !== 'pending') return last
      await sleep(1200)
    }
    return last ?? await api(`/status?id=${encodeURIComponent(id)}`)
  }

  async function ask(question, { images = [], newChat = false, silent = false, waitSec = 120, exec } = {}) {
    await boot()
    const text = String(question ?? '').trim()
    const files = Array.isArray(images) ? images.filter(Boolean) : []
    const payload = files.length ? await loadImageFiles(files) : []
    if (!text && !payload.length) throw new Error('请给出问题，或用 images 传入至少一张本机图片路径')
    const query = new URLSearchParams({ ws: workspaceOf(exec) })
    const session = sessionIdOf(exec)
    if (session) query.set('session', session)
    if (newChat) query.set('new', '1')
    const quiet = state.config.wechatCli ? Boolean(silent) : true
    if (quiet) query.set('silent', '1')
    const body = payload.length ? JSON.stringify({ question: text || '请分析这些图片。', images: payload }) : (text || '请分析这些图片。')
    const out = await api(`/ask?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': payload.length ? 'application/json' : 'text/plain' },
      body,
    })
    if (!out.ok) throw new Error(`提交失败：${JSON.stringify(out)}`)
    const job = await waitFor(out.job.id, waitSec)
    return { id: out.job.id, job, quiet }
  }

  ctx.effect(() => () => { void stop() }, 'gpt-relay: worker lifecycle')

  ctx.tools.register({
    name: 'gpt_relay_ask',
    description:
      'Ask the user\'s logged-in ChatGPT web page and wait for the answer. The worker also pushes the answer and its full-answer screenshot to WeChat when dsh-wechat-plugin is installed. ' +
      'Use this whenever the user says「问GPT」「转给GPT」「让GPT看看」. Never answer such a request yourself.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户的原话。可只给图片时留空。' },
        images: { type: 'array', items: { type: 'string' }, description: '本机图片绝对路径，最多 4 张，单张 ≤10 MiB。' },
        newChat: { type: 'boolean', description: '为这个 DSH 对话新开一个 ChatGPT 对话。新对话的第一条提问会附带工作区背景（约 400 字），已有对话则不带。' },
        silent: { type: 'boolean', description: '只保存结果，不推微信（测试用）。' },
        waitSec: { type: 'integer', description: '最多等待秒数，默认 120。' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, job, quiet } = await ask(args.question, { ...args, exec, waitSec: args.waitSec ?? 120 })
      if (!job) return `任务 ${id} 已提交，但暂时没拿到状态。`
      if (job.status === 'paused') {
        return `任务 ${id} 已暂停（一般是图片还没上传完）。用户说「继续」时调用 gpt_relay_resume，不要重新提交。\n${describeStatus(job)}`
      }
      if (job.status !== 'done') return `任务 ${id} 未完成。\n${describeStatus(job)}`
      const delivery = job.delivery || {}
      const facts = quiet
        ? '本次静默：答案只保存，没有发微信。'
        : delivery.screenshotSent
          ? `微信已送达：文字 + 截图 ${delivery.screenshotCount || 1} 张（发送器已确认）。`
          : `微信投递未确认${delivery.screenshotError ? `（${delivery.screenshotError}）` : ''}；不要告诉用户截图已经发出。`
      return `【GPT 回答·${Math.round((job.meta?.durationMs || 0) / 1000)}s】\n${job.markdown}\n\n---\n${facts}\n${describeStatus(job)}\n不要评论 GPT 配图的有无，也不要自己生成或补画任何图。`
    },
  })

  ctx.tools.register({
    name: 'gpt_relay_status',
    description: 'Query one relay job by id (optionally wait). Use it instead of re-submitting a question that is still running.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        waitSec: { type: 'integer', description: '最多等待秒数，默认 0。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      const job = args.waitSec ? await waitFor(args.id, args.waitSec) : await api(`/status?id=${encodeURIComponent(args.id)}`)
      const body = job.status === 'done' && job.markdown ? `\n\n---\n${job.markdown}` : ''
      return `${describeStatus(job)}${body}`
    },
  })

  ctx.tools.register({
    name: 'gpt_relay_resume',
    description: 'Continue a paused job on the same ChatGPT page (same draft and attachments). Never re-ask instead.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, waitSec: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      const out = await api(`/resume?id=${encodeURIComponent(args.id)}`, { method: 'POST' })
      if (!out.ok) throw new Error(out.error || '无法继续该任务')
      const job = await waitFor(args.id, args.waitSec ?? 90)
      return describeStatus(job)
    },
  })

  ctx.tools.register({
    name: 'gpt_relay_health',
    description: 'Check the relay worker, whether the Chrome extension is polling, and what capabilities are live.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    async execute() {
      const health = await api('/health')
      const seen = health.lastTabSeen?.at ? new Date(health.lastTabSeen.at).toLocaleString('zh-CN') : '从未'
      return [
        `worker: ${state.base}`,
        `队列: ${health.queued}　进行中: ${health.active ? health.active.id : '无'}`,
        `扩展最近连接: ${seen}${health.lastTabSeen?.url ? `（${health.lastTabSeen.url}）` : ''}`,
        `微信投递: ${state.config?.wechatCli ? '已配置' : '未安装 dsh-wechat-plugin'}`,
        `能力: ${JSON.stringify(health.capabilities || {})}`,
        `最近任务: ${health.lastResult ? `${health.lastResult.id} ${health.lastResult.status} ${health.lastResult.error || ''}`.trim() : '无'}`,
      ].join('\n')
    },
  })

  ctx.tools.register({
    name: 'gpt_relay_pairing',
    description: 'Return the pairing values the Chrome extension needs (worker URL, token) and where the unpacked extension lives.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    async execute() {
      await boot()
      return [
        `配对码（一般不用粘，下面的扩展目录已经写好地址和令牌）：${state.base.replace('http://', '')}#${state.token}`,
        `扩展目录：${state.extensionDir || path.join(PACKAGE_ROOT, 'extension')}`,
        `数据目录：${state.dir}`,
        `微信：${state.config.wechatCli ? '已配置' : '未安装 dsh-wechat-plugin（只回给 agent）'}`,
        '用法：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选上面的扩展目录 → 打开 https://chatgpt.com 标签页并保持登录。',
        '换端口或换机器时：打开扩展的「选项」页，粘贴配对码保存，再刷新 ChatGPT 标签页。',
      ].join('\n')
    },
  })
}
