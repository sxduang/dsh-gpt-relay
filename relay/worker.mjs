// Stable entrypoint used by the existing Windows startup script.
import { createWorker } from './worker-app.mjs'
import { loadConfig } from './config.mjs'

const config = await loadConfig()
const app = await createWorker({ config })
const { server, log } = app
server.on('error', async (err) => {
  log('server error', String(err))
  await log.flush?.()
  process.exit(1)
})
server.listen(config.port, '127.0.0.1', () => {
  log(`worker listening on 127.0.0.1:${config.port} pid=${process.pid}`)
  console.log(`listening 127.0.0.1:${config.port}`)
})
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await app.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (err) => log('uncaught', String(err)))
