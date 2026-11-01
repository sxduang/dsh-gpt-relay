import fs from 'node:fs/promises'
import path from 'node:path'

const IMAGE_DATA_URL = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i

/** Answer files belong to the requesting workspace, with the original fallback layout. */
export function createStorage({ root, log = () => {} }) {
  const debugDir = path.join(root, 'relay', 'debug')
  const fallbackDir = path.join(root, 'answers')
  const journalWrites = new Map()

  async function init() {
    await Promise.all([fallbackDir, debugDir].map((dir) => fs.mkdir(dir, { recursive: true })))
  }

  async function scopeBase(job) {
    let ws = job.ws || null
    if (ws) {
      try { await fs.access(ws) } catch { ws = null }
    }
    if (!ws) return fallbackDir
    const base = path.join(ws, '.gpt-relay')
    const scoped = job.session ? path.join(base, 'sessions', job.session) : base
    await fs.mkdir(scoped, { recursive: true })
    return scoped
  }

  async function mediaBase(job) {
    const dir = path.join(await scopeBase(job), 'media', job.id)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  async function writeText(file, text) {
    await fs.writeFile(file, text, 'utf8')
  }

  async function writeJson(file, payload) {
    await writeText(file, JSON.stringify(payload, null, 2))
  }

  async function writeDataUrl(file, dataUrl) {
    const match = typeof dataUrl === 'string' ? IMAGE_DATA_URL.exec(dataUrl) : null
    if (!match) return false
    await fs.writeFile(file, Buffer.from(match[2], 'base64'))
    return true
  }

  async function saveImages(job, images) {
    if (!Array.isArray(images) || !images.length) return []
    const dir = await mediaBase(job)
    const files = []
    for (const [index, img] of images.entries()) {
      const dataUrl = img && img.dataUrl
      const match = typeof dataUrl === 'string' ? IMAGE_DATA_URL.exec(dataUrl) : null
      if (!match) continue
      const ext = match[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')
      const file = path.join(dir, `img-${index + 1}.${ext}`)
      try {
        await fs.writeFile(file, Buffer.from(match[2], 'base64'))
        files.push(file)
      } catch (err) {
        log('image save failed', String(err))
      }
    }
    return files
  }

  async function journal(job, markdown) {
    try {
      const file = path.join(await scopeBase(job), 'journal.md')
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
      const entry = `\n\n---\n\n## ${stamp} · ${job.id}\n\n**问：** ${job.question}\n\n**答：**\n\n${markdown}\n`
      // Serialise writes to the same journal, even when HTTP results arrive together.
      const write = (journalWrites.get(file) || Promise.resolve())
        .catch(() => {})
        .then(() => fs.appendFile(file, entry, 'utf8'))
      journalWrites.set(file, write)
      try { await write } finally {
        if (journalWrites.get(file) === write) journalWrites.delete(file)
      }
      return file
    } catch (err) {
      log('journal failed', String(err))
      return ''
    }
  }

  return { debugDir, fallbackDir, init, scopeBase, mediaBase, saveImages, journal, writeText, writeJson, writeDataUrl }
}
