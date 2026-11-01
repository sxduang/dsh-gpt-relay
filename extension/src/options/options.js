// Options page: store the pairing code, and check that the worker answers.

const codeInput = document.getElementById('code')
const statusBox = document.getElementById('status')

function show(text) {
  statusBox.textContent = text
}

function parse(text) {
  const raw = String(text || '').trim()
  const match = raw.match(/^(?:https?:\/\/)?([^#\s]+)#([0-9a-fA-F]{8,128})$/)
  if (!match) return null
  return { worker: `http://${match[1]}`, token: match[2].toLowerCase() }
}

async function load() {
  const { endpoint } = await chrome.storage.local.get('endpoint')
  if (!endpoint) {
    show('尚未配对。')
    return
  }
  codeInput.value = `${endpoint.worker.replace(/^https?:\/\//, '')}#${endpoint.token}`
  show(`已保存：${endpoint.worker}`)
}

document.getElementById('save').addEventListener('click', async () => {
  const parsed = parse(codeInput.value)
  if (!parsed) {
    show('配对码格式不对，应为 127.0.0.1:8123#<32位令牌>')
    return
  }
  await chrome.storage.local.set({ endpoint: parsed })
  show(`已保存：${parsed.worker}\n现在回到 ChatGPT 标签页刷新一下（F5）。`)
})

document.getElementById('test').addEventListener('click', async () => {
  const parsed = parse(codeInput.value)
  if (!parsed) {
    show('配对码格式不对，应为 127.0.0.1:8123#<32位令牌>')
    return
  }
  show('正在连接…')
  try {
    const response = await fetch(`${parsed.worker}/health?token=${encodeURIComponent(parsed.token)}`)
    if (response.status === 403) {
      show('worker 有响应，但令牌不对。重新让 agent 调 gpt_relay_pairing 取一次。')
      return
    }
    if (!response.ok) {
      show(`worker 返回 ${response.status}。`)
      return
    }
    const health = await response.json()
    const seen = health.lastTabSeen && health.lastTabSeen.at
      ? new Date(health.lastTabSeen.at).toLocaleString()
      : '还没有'
    show([
      '连接正常。',
      `队列 ${health.queued}，进行中 ${health.active ? health.active.id : '无'}`,
      `扩展最近连接：${seen}`,
      `能力：${JSON.stringify(health.capabilities || {})}`,
    ].join('\n'))
  } catch (error) {
    show(`连不上 ${parsed.worker}：${error.message}\n确认 DSH 正在运行、插件已启用。`)
  }
})

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('endpoint')
  codeInput.value = ''
  show('已清除。扩展会回退到安装时内置的默认值。')
})

load()
