#!/usr/bin/env node
// Fresh-consumer install smoke harness for @qbit-oss/protocol and @qbit-oss/api.
//
// Packs each package into a tarball, installs the tarballs into one clean
// throwaway project OUTSIDE this workspace (so pnpm workspace linking can never
// substitute the local source), and runs scripts/consumer-smoke.mjs and
// scripts/consumer-smoke-api.mjs against the packages imported by name. Uses
// npm (not the workspace package manager) for the consumer install so
// resolution and the @noble/hashes runtime dep mirror an external consumer.
// Validates the published artifact: the `files` whitelist, the `exports` map,
// ESM+CJS entry points, and the dependency graph — the class of bug that
// in-repo tests and submodule consumption both hide.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
// Each publishable package and the smoke script that imports it by name.
const packages = [
  { dir: join(repoRoot, 'packages', 'protocol'), smoke: 'consumer-smoke.mjs' },
  { dir: join(repoRoot, 'packages', 'api'), smoke: 'consumer-smoke-api.mjs' },
]

// The version npm resolved for `name` in `cwd`, or 'unknown'. `npm ls` finds it
// under every install strategy (hoisted, shallow, linked); reading
// node_modules/<name>/package.json directly only works for the hoisted layout.
function resolvedVersion(cwd, name) {
  try {
    const out = execFileSync('npm', ['ls', name, '--all', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const stack = [JSON.parse(out)]
    while (stack.length > 0) {
      const node = stack.pop()
      for (const [dep, info] of Object.entries(node?.dependencies ?? {})) {
        if (dep === name && typeof info?.version === 'string') return info.version
        stack.push(info)
      }
    }
  } catch {
    // Logging the version is informational; never fail the smoke over it.
  }
  return 'unknown'
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`)
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

const stage = mkdtempSync(join(tmpdir(), 'qbit-protocol-consumer-'))
let passed = false
try {
  // 1) Pack the real publishable tarballs.
  for (const { dir } of packages) run('npm', ['pack', dir, '--pack-destination', stage, '--silent'])
  const tarballs = readdirSync(stage).filter(f => f.endsWith('.tgz'))
  if (tarballs.length !== packages.length) {
    throw new Error(`npm pack produced ${tarballs.length} tarballs, expected ${packages.length}`)
  }

  // 2) Clean consumer project (ESM) outside the workspace; install with npm.
  const consumerDir = join(stage, 'consumer')
  mkdirSync(consumerDir)
  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'qbit-protocol-consumer', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`
  )
  for (const { smoke } of packages) copyFileSync(join(here, smoke), join(consumerDir, smoke))
  // --ignore-scripts: the consumer install resolves dependencies from the live
  // registry with no lockfile, so no dependency lifecycle script may run. Only
  // the install gets it: `npm pack` above must still run any prepack build.
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.map(f => join(stage, f))], {
    cwd: consumerDir,
  })
  // Record which @noble/hashes release the smoke actually exercised: with no
  // lockfile this is the newest 1.8.x the registry serves today.
  console.log(`consumer resolved @noble/hashes@${resolvedVersion(consumerDir, '@noble/hashes')}`)

  // 3) Run the consumer assertions against the installed packages.
  for (const { smoke } of packages) run('node', [smoke], { cwd: consumerDir })
  passed = true
} finally {
  if (passed) {
    rmSync(stage, { recursive: true, force: true })
    console.log('consumer install smoke: PASS')
  } else {
    console.error(`consumer install smoke: FAIL (stage kept for inspection: ${stage})`)
  }
}
