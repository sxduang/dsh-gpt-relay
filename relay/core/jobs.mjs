import { randomUUID } from 'node:crypto'
import { buildPrompt } from './context.mjs'
import { attachmentMetadata, releaseAttachments } from './attachments.mjs'

/** In-memory FIFO; timeout and wire statuses deliberately match the original worker. */
export function createJobQueue({ config, threads, log, sendWechat, getLastTabSeen }) {
  const jobs = new Map()
  const queue = []
  let activeId = null
  let creationChain = Promise.resolve()

  function clearJobTimers(job) {
    if (job.timer) clearTimeout(job.timer)
    if (job.hintTimer) clearTimeout(job.hintTimer)
  }

  function startJobTimeout(job) {
    job.timer = setTimeout(() => {
      const live = jobs.get(job.id)
      if (!live || live.status === 'done' || live.status === 'failed') return
      const wasRunning = live.status === 'running'
      live.status = 'failed'
      live.error = wasRunning ? 'timeout' : 'no-tab'
      live.detail = `超过 ${config.jobTimeoutSec}s 没有完成`
      live.finishedAt = Date.now()
      releaseAttachments(live)
      if (activeId === job.id) activeId = null
      log('job timeout', { id: job.id })
      void sendWechat(`⚠️ GPT 中转超时：${live.detail}\n问题：${job.question.slice(0, 60)}`)
        .catch((err) => log('timeout notification failed', String(err)))
    }, config.jobTimeoutSec * 1000)
    job.hintTimer = setTimeout(() => {
      const live = jobs.get(job.id)
      if (!live || live.status !== 'queued') return
      log('job still queued', { id: job.id, tabSeen: getLastTabSeen() })
      void sendWechat('⚠️ 任务发出去了，但没等到 Chrome 里的 GPT 页面来领取。\n请确认：那个 ChatGPT 标签页开着，并且刷新过（F5）。')
        .catch((err) => log('queue notification failed', String(err)))
    }, config.queueHintSec * 1000)
  }

  async function enqueue({ kind, question, ws, session, newChat, silent = false, attachments = [] }) {
    if(kind==='ask') {
      const blocked=[...jobs.values()].find(job=>job.attachments.length && !job.submitClaimed && ['queued','running','paused'].includes(job.status) && (session ? job.session===session : !job.session && job.ws===ws))
      if(blocked) throw Object.assign(new Error(`upload-${blocked.status}:${blocked.id}；${blocked.status==='paused'?`使用 resume ${blocked.id} 继续原草稿`:`使用 status ${blocked.id} 查询原任务`}，不要重新 ask 或 --new`),{statusCode:409})
    }
    const mapped = session ? threads[session] : null
    const withContext = !mapped || !!newChat
    const job = {
      id: randomUUID().slice(0, 8), kind: kind || 'ask', question: question || '', ws, session,
      conversationUrl: !newChat && mapped?.url ? mapped.url : '', newChat: !!newChat || !mapped,
      withContext, explicitNewChat:!!newChat, status: 'queued', createdAt: Date.now(), silent, attachments,
    }
    job.text = kind === 'ask' ? (withContext ? await buildPrompt(ws, question) : question) : question
    jobs.set(job.id, job)
    queue.push(job.id)
    startJobTimeout(job)
    log('job queued', { id: job.id, kind: job.kind, ws, session, newChat: job.newChat,
      thread: job.conversationUrl || '(new)', withContext, chars: job.text.length })
    return job
  }

  function createJob(input) {
    // Async brief reads must not reorder concurrent asks.
    const pending = creationChain.then(() => enqueue(input))
    creationChain = pending.catch(() => {})
    return pending
  }

  function takeJob(tab, { supportsImages = false, supportsResume = false, tabId = null } = {}) {
    if (activeId) return null
    while (queue.length) {
      const next = jobs.get(queue[0])
      if (next?.status === 'queued' && next.attachments.length && !supportsImages) return null
      if (next?.status === 'queued' && next.attachments.length && !supportsResume) return null
      if (next?.resumeUpload && (next.draftTabId!==tabId || next.draftUrl!==tab)) return null
      const id = queue.shift()
      const job = jobs.get(id)
      if (!job || job.status !== 'queued') continue
      job.status = 'running'
      if(!job.explicitNewChat && !job.resumeUpload && job.session && threads[job.session]?.url) {
        job.conversationUrl=threads[job.session].url;job.newChat=false
      }
      job.startedAt = Date.now()
      job.tab = tab
      job.ownerTabId=tabId
      activeId = id
      log('job taken', { id, tab: String(tab).slice(0, 120) })
      return job
    }
    return null
  }

  function releaseJob(job) {
    clearJobTimers(job)
    releaseAttachments(job)
    if (activeId === job.id) activeId = null
  }

  function publicJob(job) {
    return { id: job.id, kind: job.kind, text: job.text, newChat: job.newChat,
      // The page re-renders prepended context, so a bubble rarely equals text.
      ...(job.withContext && job.kind === 'ask' && job.question ? { anchor: String(job.question).slice(0, 600) } : {}),
      conversationUrl: job.conversationUrl || '', resumeUpload:!!job.resumeUpload, timeoutSec: config.jobTimeoutSec, selectors: config.selectors || {},
      ...(job.attachments.length ? { attachments: attachmentMetadata(job.attachments) } : {}) }
  }

  function jobState({id,action,url,tabId}) {
    const job=jobs.get(id)
    if(!job || job.status!=='running' || job.ownerTabId!==tabId || !Number.isInteger(tabId)) throw Object.assign(new Error('任务已失效或不属于这个标签页'),{statusCode:409})
    if(!/^https:\/\/chatgpt\.com\//.test(url || '')) throw Object.assign(new Error('invalid conversation URL'),{statusCode:400})
    if(action==='draft' && !job.submitClaimed) {
      if(job.resumeUpload && job.draftUrl!==url) throw Object.assign(new Error('原草稿页面已变化'),{statusCode:409})
      job.draftUrl=url;job.draftTabId=tabId;job.phase='uploading'
    } else if(action==='claim-send' && !job.submitClaimed && job.draftUrl===url) {
      job.submitClaimed=true;job.phase='awaiting-answer'
      clearJobTimers(job);startJobTimeout(job)
    } else if(action==='submitted' && job.submitClaimed) {
      job.submittedUrl=url
    } else throw Object.assign(new Error('任务已经提交或状态不允许发送'),{statusCode:409})
    return job
  }

  function pauseJob(job) {
    if(job.submitClaimed || !job.draftUrl || !Number.isInteger(job.draftTabId)) throw Object.assign(new Error('没有可安全继续的上传草稿'),{statusCode:409})
    releaseJob(job)
    job.status='paused';job.phase='waiting-upload';job.pausedAt=Date.now()
  }

  function resumeJob(id) {
    const job=jobs.get(id)
    if(!job || job.status!=='paused' || job.submitClaimed) throw Object.assign(new Error('任务不存在、未暂停或已经尝试发送；不会重新提问'),{statusCode:409})
    job.resumeUpload=true;job.newChat=false;job.conversationUrl=job.draftUrl
    job.status='queued';job.error='';job.detail='';job.phase='resume-upload'
    queue.push(job.id);startJobTimeout(job)
    return job
  }

  return { jobs, createJob, takeJob, releaseJob, publicJob, jobState, pauseJob, resumeJob,
    get activeId() { return activeId }, get queued() { return queue.length },
    async close() {
      await creationChain
      for (const job of jobs.values()) clearJobTimers(job)
    },
  }
}
