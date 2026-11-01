// GPT Relay CLI — what the agent runs.
//
//   node relay.mjs ask "问题" [--new] [--wait 秒]
//   node relay.mjs health | status <id> [--wait 秒] | log [行数]
//
// The workspace is the directory this command runs in; the conversation is the session
// the agent is in. Nothing is selected, nothing is stored.

import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, resolveRoot, resolveConfigPath, rootOfConfig } from './config.mjs'
import { loadImageFiles } from './core/attachments.mjs'

const ROOT = resolveRoot()
const CONFIG_PATH = resolveConfigPath(ROOT)
const CONFIG = await loadConfig(ROOT)
const LOG_FILE = path.join(rootOfConfig(CONFIG_PATH), 'relay', 'relay.log')
const BASE = `http://127.0.0.1:${CONFIG.port}`
const TOKEN = CONFIG.token

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}

async function api(pathname, options = {}) {
  const sep = pathname.includes('?') ? '&' : '?'
  const res = await fetch(`${BASE}${pathname}${sep}token=${TOKEN}`, options)
  return res.json()
}

function takeFlags(list) {
  const opts = { _: [], images: [], wait: undefined, file: undefined, newChat: false, session: undefined }
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]
    if (arg === '--wait') opts.wait = Number(list[++i])
    else if (arg === '--new') opts.newChat = true
    else if (arg === '--session') opts.session = list[++i]
    else if (arg === '--silent') opts.silent = true
    else if (arg === '--file') opts.file = list[++i]
    else if (arg === '--image') {
      const file = list[++i]
      if (!file || file.startsWith('--')) throw new Error('--image 后必须填写图片文件路径')
      opts.images.push(file)
    }
    else opts._.push(arg)
  }
  return opts
}

async function waitFor(id, seconds) {
  const deadline = Date.now() + seconds * 1000
  let last = null
  while (Date.now() < deadline) {
    last = await api(`/status?id=${encodeURIComponent(id)}`)
    if ((last.status === 'done' && last.delivery?.status !== 'pending') || last.status === 'failed' || last.status==='paused') return last
    await sleep(1200)
  }
  return last
}

const [command, ...rest] = process.argv.slice(2)

try {
  const opts = takeFlags(rest)
  if (opts.images.length && command !== 'ask') throw new Error('--image 仅用于 ask 命令')
  if (command === 'health') {
    console.log(JSON.stringify(await api('/health'), null, 2))
  } else if (command === 'ask') {
    const images = await loadImageFiles(opts.images)
    const question = opts._.join(' ').trim() || (images.length ? '请分析这些图片。' : '')
    if (!question) throw new Error('用法：ask "问题" [--image 图片路径，可重复] [--new] [--wait 秒]')
    if (images.length) {
      const health = await api('/health')
      if (health.capabilities?.imageUpload !== 1) throw new Error('当前 worker 不支持图片上传，请先重启到新版 worker')
      if (health.capabilities?.uploadResume !== 1) throw new Error('当前 worker 不支持图片暂停继续，请先重启到新版 worker')
    }

    const session = opts.session || process.env.DSH_SESSION_ID || ''
    const ws = process.cwd()
    const qs = new URLSearchParams({ ws })
    if (session) qs.set('session', session)
    if (opts.newChat) qs.set('new', '1')
    if (opts.silent) qs.set('silent', '1')

    const out = await api(`/ask?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': images.length ? 'application/json' : 'text/plain' },
      body: images.length ? JSON.stringify({ question, images }) : question,
    })
    if (!out.ok) throw new Error(JSON.stringify(out))
    console.log(JSON.stringify({ ok: true, id: out.job.id, ws: out.ws }, null, 2))

    const seconds = opts.wait !== undefined ? opts.wait : 90
    if (seconds > 0) {
      const done = await waitFor(out.job.id, seconds)
      if (!done) {
        console.log('（还没答完，答案到了会自动推微信）')
      } else if (done.status === 'done') {
        console.log(`\n--- GPT 的回答（${done.chars} 字）---\n${done.markdown}`)
        if (done.answerFile) console.log(`\n已存：${done.answerFile}`)
        if (done.delivery?.silent) console.log('\n[静默模式] 回答已保存，本次未发送微信。')
        else if (done.delivery?.screenshotSent) console.log('\n[截图已发送] 微信发送器已确认截图投递。')
        else console.log(`\n[截图未确认发送] ${done.delivery?.screenshotError || done.meta?.screenshotError || done.delivery?.status || '状态未知'}；不要告诉用户截图已经发出。`)
        console.log('不要评论 GPT 配图的有无，也不要自己生成或补画任何图。')
        if (done.delivery?.status === 'partial' || done.delivery?.status === 'failed') console.log('本次投递未全部成功，请查看任务 delivery 字段。')
      } else if(done.status==='paused') {
        console.log(`\n[等待图片] 原任务 ${done.id} 已暂停。图片加载好后执行 resume ${done.id}；禁止重复 ask、--new 或新建 DSH 会话。`)
      } else if(done.status==='queued' || done.status==='running') {
        console.log(`\n[仍在处理] 任务 ${done.id}，阶段 ${done.phase || done.status}。命令等待结束不代表失败；继续查询 status，不要重新 ask。`)
      } else {
        console.log(`\n失败：${done.error} ${done.detail || ''}`)
      }
    }
  } else if (command === 'resume') {
    const id=opts._[0]
    if(!id) throw new Error('用法：resume <原任务id> [--wait 秒]')
    const health=await api('/health')
    if(health.capabilities?.uploadResume!==1) throw new Error('worker 尚未加载图片继续功能，请重启新版 worker；不要重新 ask')
    const out=await api(`/resume?id=${encodeURIComponent(id)}`,{method:'POST'})
    if(!out.ok) throw new Error(out.error)
    console.log(JSON.stringify({ok:true,id:out.job.id,resuming:true},null,2))
    if(opts.wait>0) console.log(JSON.stringify(await waitFor(id,opts.wait),null,2))
  } else if (command === 'images') {
    const session = opts.session || process.env.DSH_SESSION_ID || ''
    const qs = new URLSearchParams({ ws: process.cwd() })
    if (session) qs.set('session', session)
    const out = await api(`/ask?kind=images&${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '',
    })
    if (!out.ok) throw new Error(JSON.stringify(out))
    console.log(JSON.stringify({ ok: true, id: out.job.id }, null, 2))
    const done = await waitFor(out.job.id, 120)
    if (!done) console.log('（还没取到，稍后会自动推微信）')
    else if (done.status === 'done') console.log(`已取到 ${(done.meta && done.meta.images) || 0} 张图，已发微信`)
    else console.log(`失败：${done.error} ${done.detail || ''}`)
  } else if (command === 'status') {
    const id = opts._[0]
    if (!id) throw new Error('用法：status <id> [--wait 秒]')
    const out = opts.wait ? await waitFor(id, opts.wait) : await api(`/status?id=${encodeURIComponent(id)}`)
    console.log(JSON.stringify(out, null, 2))
  } else if (command === 'log') {
    const n = Number(opts._[0] || 30)
    const file = LOG_FILE
    if (!(await exists(file))) console.log('(no log yet)')
    else console.log((await fs.readFile(file, 'utf8')).trimEnd().split('\n').slice(-n).join('\n'))
  } else if (command === 'dump') {
    const out = await api('/ask?kind=dump', { method: 'POST', body: '' })
    const done = await waitFor(out.job.id, 40)
    console.log(JSON.stringify(done, null, 2))
    if (done.reportFile && await exists(done.reportFile)) console.log('\n--- report ---\n' + await fs.readFile(done.reportFile, 'utf8'))
  } else if (command === 'dryrun') {
    const out = await api('/ask?kind=dryrun', { method: 'POST', body: '' })
    const done = await waitFor(out.job.id, 45)
    console.log(JSON.stringify(done, null, 2))
    if (done.reportFile && await exists(done.reportFile)) console.log('\n--- report ---\n' + await fs.readFile(done.reportFile, 'utf8'))
  } else if (command === 'probe') {
    const code = opts.file ? await fs.readFile(opts.file, 'utf8') : opts._.join(' ').trim()
    if (!code) throw new Error('用法：probe --file spec.json')
    const out = await api('/ask?kind=probe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: code })
    const done = await waitFor(out.job.id, 45)
    console.log(JSON.stringify({ id: done.id, status: done.status, error: done.error, detail: done.detail, reportFile: done.reportFile }, null, 2))
    if (done.reportFile && await exists(done.reportFile)) console.log('\n--- value ---\n' + await fs.readFile(done.reportFile, 'utf8'))
  } else {
    console.log(['用法：', '  relay.mjs ask "问题" [--image 图片路径，可重复] [--new] [--wait 秒]', '  relay.mjs health | status <id> | log [行数]'].join('\n'))
  }
} catch (err) {
  console.error('ERROR:', err.message)
  process.exit(1)
}
