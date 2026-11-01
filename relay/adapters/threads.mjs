import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/** Preserve one mutable map for callers, and publish each snapshot with an atomic rename. */
export function createThreadStore(file) {
  const threads = {}
  let writes = Promise.resolve()

  async function load() {
    let loaded
    try { loaded = JSON.parse(await fs.readFile(file, 'utf8')) } catch { loaded = {} }
    for (const key of Object.keys(threads)) delete threads[key]
    Object.defineProperties(threads, Object.getOwnPropertyDescriptors(loaded || {}))
    return threads
  }

  function save() {
    const snapshot = JSON.stringify(threads, null, 2)
    const write = writes.catch(() => {}).then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, snapshot, 'utf8')
        await fs.rename(temporary, file)
      } finally {
        await fs.unlink(temporary).catch(() => {})
      }
    })
    writes = write
    return write
  }

  return { threads, load, save }
}
