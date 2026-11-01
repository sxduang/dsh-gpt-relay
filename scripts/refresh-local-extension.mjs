import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { materializeExtension } from '../lib/index.js'

const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'gpt-relay')
const config = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'))
const target = await materializeExtension(dir, config, (message) => console.log(message))
console.log(`extension copy: ${target}`)
console.log(`port=${config.port} token=${String(config.token).slice(0, 6)}…`)
