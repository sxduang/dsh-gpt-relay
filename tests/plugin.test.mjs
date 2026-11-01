import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { materializeExtension } from '../lib/index.js'
import { dataConfigPath, resolveConfigPath, rootOfConfig } from '../relay/config.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

async function temporary(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

test('the materialised extension carries this machine endpoint and says which version it is', async () => {
  const home = await temporary('relay-ext-')
  try {
    const dir = await materializeExtension(home, { port: 9876, token: 'tok-123' })
    assert.equal(dir, path.join(home, 'extension'))
    const background = await fs.readFile(path.join(dir, 'background.js'), 'utf8')
    assert.match(background, /http:\/\/127\.0\.0\.1:9876/)
    assert.match(background, /tok-123/)
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.version, pkg.version)
    const record = JSON.parse(await fs.readFile(path.join(dir, '.materialized.json'), 'utf8'))
    assert.ok(record.files['background.js'])
    assert.equal(record.version, pkg.version)
    assert.equal(path.resolve(record.source), path.resolve(root))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('an unchanged copy is left alone and a hand edit is backed up before it is replaced', async () => {
  const home = await temporary('relay-ext-')
  const logs = []
  try {
    await materializeExtension(home, { port: 9876, token: 'tok-123' }, message => logs.push(message))
    const target = path.join(home, 'extension', 'background.js')
    const generated = await fs.readFile(target, 'utf8')
    const before = (await fs.stat(target)).mtimeMs
    logs.length = 0
    await materializeExtension(home, { port: 9876, token: 'tok-123' }, message => logs.push(message))
    assert.equal((await fs.stat(target)).mtimeMs, before, 'an unchanged extension must not be rewritten')
    assert.deepEqual(logs, [])

    const edited = `${generated}\n// a local patch the user made by hand\n`
    await fs.writeFile(target, edited, 'utf8')
    await materializeExtension(home, { port: 9876, token: 'tok-123' }, message => logs.push(message))
    assert.equal(await fs.readFile(target, 'utf8'), generated)
    const backups = (await fs.readdir(path.join(home, 'extension'))).filter(name => name.includes('.edited-'))
    assert.equal(backups.length, 1)
    assert.equal(await fs.readFile(path.join(home, 'extension', backups[0]), 'utf8'), edited)
    assert.ok(logs.some(line => line.includes('本地修改')), JSON.stringify(logs))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('the CLI finds the generated config in the data directory when the package ships none', async () => {
  const home = await temporary('relay-home-')
  const emptyRoot = path.join(home, 'installed-package')
  const saved = { DSH_HOME: process.env.DSH_HOME, GPT_RELAY_CONFIG: process.env.GPT_RELAY_CONFIG }
  try {
    await fs.mkdir(path.join(home, 'gpt-relay'), { recursive: true })
    await fs.mkdir(path.join(emptyRoot, 'relay'), { recursive: true })
    await fs.writeFile(path.join(home, 'gpt-relay', 'config.json'), '{}\n', 'utf8')
    process.env.DSH_HOME = home
    delete process.env.GPT_RELAY_CONFIG
    assert.equal(dataConfigPath(), path.join(home, 'gpt-relay', 'config.json'))
    assert.equal(resolveConfigPath(emptyRoot), dataConfigPath())
    assert.equal(rootOfConfig(path.join(emptyRoot, 'relay', 'config.json')), emptyRoot)
    assert.equal(rootOfConfig(dataConfigPath()), path.join(home, 'gpt-relay'))

    // An explicit GPT_RELAY_CONFIG always wins.
    process.env.GPT_RELAY_CONFIG = path.join(emptyRoot, 'elsewhere.json')
    assert.equal(resolveConfigPath(emptyRoot), path.join(emptyRoot, 'elsewhere.json'))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(home, { recursive: true, force: true })
  }
})
