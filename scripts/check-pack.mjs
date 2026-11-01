// Verifies the contents of the tarball that `npm publish` would upload.
// Reads pack.json produced by: npm pack --dry-run --json --ignore-scripts > pack.json
import { readFileSync } from 'node:fs'

const required = [
  'package.json',
  'lib/index.js',
  'cordis.patch.yml',
  'extension/manifest.json',
  'extension/background.js',
  'extension/content.js',
  'extension/options.html',
  'extension/options.js',
  'scripts/build-extension.mjs',
  'scripts/check.mjs',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
]

const forbidden = [/^relay\/config\.json$/, /^\.gpt-relay\//, /^spike\//, /^backups\//]

let report
try {
  report = JSON.parse(readFileSync('pack.json', 'utf8'))
} catch (error) {
  console.error(`could not read pack.json: ${error.message}`)
  process.exit(1)
}

const files = (Array.isArray(report) ? report[0].files : report.files).map(f => f.path)
const missing = required.filter(p => !files.includes(p))
const leaked = files.filter(p => forbidden.some(re => re.test(p)))

if (missing.length) console.error(`missing from tarball: ${missing.join(', ')}`)
if (leaked.length) console.error(`must not be published: ${leaked.join(', ')}`)
if (missing.length || leaked.length) process.exit(1)

console.log(`tarball ok: ${files.length} files, ${required.length} required entries present, no local data`)
