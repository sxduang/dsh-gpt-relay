import fs from 'node:fs/promises'

/** Enqueue complete lines without blocking HTTP; flush is used during shutdown. */
export function createLogger(file, { onError = (err) => console.error('relay log failed:', String(err)) } = {}) {
  let writes = Promise.resolve()
  function log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ')}`
    writes = writes.then(() => fs.appendFile(file, line + '\n')).catch((err) => {
      // Logging failure must not become an unhandled rejection or poison later writes.
      try { onError(err) } catch {}
    })
  }
  log.flush = () => writes
  return log
}
