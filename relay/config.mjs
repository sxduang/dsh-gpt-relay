import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve installation paths independently of the caller's workspace.
export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function resolveRoot() {
  return process.env.GPT_RELAY_ROOT ? path.resolve(process.env.GPT_RELAY_ROOT) : defaultRoot
}

/** The generated runtime config (port, token, node, WeChat CLI) wins over the checked-in example. */
export function resolveConfigPath(root = resolveRoot()) {
  return process.env.GPT_RELAY_CONFIG
    ? path.resolve(process.env.GPT_RELAY_CONFIG)
    : path.join(root, 'relay', 'config.json')
}

export async function loadConfig(root = resolveRoot()) {
  const config = JSON.parse(await readFile(resolveConfigPath(root), 'utf8'))
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('config.port must be a TCP port')
  if (typeof config.token !== 'string' || !config.token) throw new Error('config.token is required')
  for (const key of ['jobTimeoutSec', 'queueHintSec', 'chunkChars']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`config.${key} must be positive`)
  }
  return config
}
