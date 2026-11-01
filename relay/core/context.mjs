import { readFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'

async function readSnippet(file, max) {
  try {
    const text = await readFile(file, 'utf8')
    return text.length > max ? `${text.slice(0, max)}…` : text
  } catch { return '' }
}

export function workspaceName(wsPath) {
  try { return path.basename(wsPath) } catch { return wsPath }
}

export async function buildContext(wsPath, budget = 1800) {
  try {
    if (!(await stat(wsPath)).isDirectory()) return ''
  } catch { return '' }

  // AGENTS.md is an agent contract, never prompt content.
  const intro = ((await readSnippet(path.join(wsPath, '.gpt-relay', 'brief.md'), 900)) ||
    (await readSnippet(path.join(wsPath, 'README.md'), 900))).replace(/\n{2,}/g, '\n').trim()
  let entries = []
  try {
    entries = (await readdir(wsPath, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 40).map((e) => e.isDirectory() ? `${e.name}/` : e.name)
  } catch { /* The brief remains useful when listing fails. */ }
  const lines = ['【工作区背景】', `名称：${workspaceName(wsPath)}`, `路径：${wsPath}`]
  if (intro) lines.push(`说明：${intro}`)
  if (entries.length) lines.push(`目录：${entries.join('、')}`)
  const text = lines.join('\n')
  return text.length > budget ? `${text.slice(0, budget)}…` : text
}

export async function buildPrompt(wsPath, question) {
  const context = await buildContext(wsPath)
  return context ? `${context}\n\n【问题】\n${question}` : question
}
