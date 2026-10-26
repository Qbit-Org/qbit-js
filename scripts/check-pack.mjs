#!/usr/bin/env node
// Assert what each publishable package's npm tarball contains.
//
// `npm pack --dry-run` runs the package's `prepack` (a fresh tsup build), so
// this also proves a pack from a clean checkout ships the built `lib/` and not
// a stale or missing one. Fails when a required file is absent, anything
// outside the expected set would be published, or a package's LICENSE copy has
// drifted from the root LICENSE.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'lib/index.js',
  'lib/index.mjs',
  'lib/index.d.ts',
  'lib/index.d.mts',
]
const ALLOWED = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^lib\//, /^src\//, /^docs\//]

const packages = ['protocol', 'api']
const rootLicense = readFileSync(join(repoRoot, 'LICENSE'), 'utf8')
let failed = false

for (const name of packages) {
  const cwd = join(repoRoot, 'packages', name)
  // npm only ships a LICENSE from the package directory, so each package keeps
  // a copy; a published version's license can't be corrected afterwards.
  if (readFileSync(join(cwd, 'LICENSE'), 'utf8') !== rootLicense) {
    failed = true
    console.error(`packages/${name}/LICENSE differs from the root LICENSE`)
  }
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  // prepack's build log shares stdout with npm's JSON, which comes last.
  const json = out.startsWith('[') ? out : out.slice(out.lastIndexOf('\n[') + 1)
  const [pack] = JSON.parse(json)
  const files = pack.files.map(file => file.path)
  const missing = REQUIRED.filter(path => !files.includes(path))
  const unexpected = files.filter(path => !ALLOWED.some(pattern => pattern.test(path)))
  console.log(`${pack.name}@${pack.version}: ${files.length} files, ${pack.unpackedSize} bytes unpacked`)
  if (missing.length > 0) {
    failed = true
    console.error(`  missing: ${missing.join(', ')}`)
  }
  if (unexpected.length > 0) {
    failed = true
    console.error(`  unexpected: ${unexpected.join(', ')}`)
  }
}

if (failed) process.exit(1)
console.log('pack check: PASS')
