import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
function run(args) {
  const out = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (out.error) throw out.error
  if (out.status !== 0) process.exit(out.status || 1)
}
async function sourceFiles(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(file))
    else if (/\.(mjs|js)$/.test(entry.name)) files.push(file)
  }
  return files
}
for (const dir of ['relay', 'extension', 'scripts', 'tests']) {
  for (const file of await sourceFiles(path.join(root, dir))) run(['--check', file])
}
console.log('All JavaScript syntax checks passed.')
run(['scripts/build-extension.mjs', '--check'])
run(['--test', 'tests/*.test.mjs'])
