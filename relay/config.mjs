import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve installation paths independently of the caller's workspace.
export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function resolveRoot() {
  return process.env.GPT_RELAY_ROOT ? path.resolve(process.env.GPT_RELAY_ROOT) : defaultRoot
}

/** Where the plugin writes its runtime config: <DSH_HOME>/gpt-relay/config.json. */
export function dataConfigPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'gpt-relay', 'config.json')
}

/**
 * The generated runtime config (port, token, node, WeChat CLI) wins over the
 * checked-in example. An installed package has no relay/config.json at all, so
 * the CLI must also look in the data directory before giving up.
 */
export function resolveConfigPath(root = resolveRoot()) {
  if (process.env.GPT_RELAY_CONFIG) return path.resolve(process.env.GPT_RELAY_CONFIG)
  const local = path.join(root, 'relay', 'config.json')
  if (existsSync(local)) return local
  const data = dataConfigPath()
  return existsSync(data) ? data : local
}

/** The worker keeps its log at <root>/relay/relay.log; recover <root> from the config path. */
export function rootOfConfig(configPath) {
  const dir = path.dirname(configPath)
  return path.basename(dir) === 'relay' ? path.dirname(dir) : dir
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
