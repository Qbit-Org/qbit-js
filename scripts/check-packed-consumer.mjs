#!/usr/bin/env node
// Compile and load the packed packages the way a consumer does.
//
// Packs both packages (`npm pack` runs `prepack`, a fresh tsup build) and
// unpacks the tarballs into a throwaway project outside the workspace. Then:
//
// 1. Type-checks a consumer against the published declarations with
//    `skipLibCheck: false`, twice: as a Node-only project (`lib: ["ES2022"]`,
//    `types: ["node"]`, no DOM lib) and as a browser project (`lib: ["ES2022",
//    "DOM"]`, no `@types/node`). A declaration that names a DOM-only or a
//    Node-only type fails one of them. A `.mts` and a `.cts` file resolve the
//    `import` and `require` export conditions, so both `lib/index.d.mts` and
//    `lib/index.d.ts` are checked.
// 2. Loads the CommonJS and the ESM build side by side and checks that each
//    error class's `is()` recognizes an error from the other build, where
//    `instanceof` cannot, and that a client passes a `fetchFn`'s error from
//    the other build through as it is.
//
// Package names, and so the install paths and import specifiers, come from
// each package's package.json, and must match the name in its tarball.
//
// Works offline: TypeScript, `@types/node` and `@noble/hashes` come from this
// workspace's install, at the versions the lockfile pins.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const apiDir = join(repoRoot, 'packages', 'api')
const requireFromApi = createRequire(join(apiDir, 'package.json'))
const tscPath = join(dirname(requireFromApi.resolve('typescript/package.json')), 'bin', 'tsc')
const typeRoot = join(apiDir, 'node_modules', '@types')
const nobleHashes = realpathSync(join(apiDir, 'node_modules', '@noble', 'hashes'))

function packageName(packageJsonPath) {
  const { name } = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  // It becomes a path under node_modules, so it must be a plain npm package name.
  if (typeof name !== 'string' || !/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name)) {
    throw new Error(`${packageJsonPath} has no valid package name: ${JSON.stringify(name)}`)
  }
  return name
}

const PACKAGE_DIRS = ['protocol', 'api']
const names = Object.fromEntries(
  PACKAGE_DIRS.map(dir => [dir, packageName(join(repoRoot, 'packages', dir, 'package.json'))])
)
const api = JSON.stringify(names.api)
const protocol = JSON.stringify(names.protocol)

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`)
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

const CONSUMER = `
import {
  EsploraClient,
  MempoolQbitClient,
  QbitApiError,
  type EsploraClientOptions,
  type QbitFetchCredentials,
} from ${api}
import { P2mrPsbtSigningError, QbitProtocolError } from ${protocol}

const credentials: QbitFetchCredentials = 'same-origin'
const options: EsploraClientOptions = {
  baseUrl: 'https://esplora.example/api',
  fetchFn: fetch,
  credentials,
  signal: new AbortController().signal,
  sleepFn: (ms: number, signal?: AbortSignal) => new Promise(resolve => setTimeout(resolve, signal?.aborted ? 0 : ms)),
}
const clients: EsploraClient[] = [new EsploraClient(options), new MempoolQbitClient(options)]

export async function rawTx(txid: string): Promise<string> {
  try {
    return await clients[0]!.getTxHex(txid, { deadlineMs: 1000 })
  } catch (error) {
    if (QbitApiError.is(error)) return error.kind
    if (P2mrPsbtSigningError.is(error)) return error.phase
    if (QbitProtocolError.is(error)) return error.code
    throw error
  }
}
`

const CONSUMER_PROJECTS = {
  node: { lib: ['ES2022'], types: ['node'], typeRoots: [typeRoot] },
  browser: { lib: ['ES2022', 'DOM'], types: [] },
}

const BRAND_CHECK = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as apiEsm from ${api}
import * as protocolEsm from ${protocol}

const require = createRequire(import.meta.url)
const apiCjs = require(${api})
const protocolCjs = require(${protocol})

function thrownBy(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('expected a throw')
}

for (const [from, to] of [[apiCjs, apiEsm], [apiEsm, apiCjs]]) {
  assert.notEqual(from.QbitApiError, to.QbitApiError, 'the two builds share one QbitApiError class')
  const error = thrownBy(() => new from.EsploraClient({ baseUrl: 'ftp://esplora.example' }))
  assert.equal(error instanceof to.QbitApiError, false)
  assert.equal(to.QbitApiError.is(error), true, 'QbitApiError.is misses the other build')
  // A fetch wrapper's error from the other build passes through as it is, not as a retried network error.
  const limited = new from.QbitApiError('rate_limit', 'from a fetch wrapper', { status: 429, retryAfterMs: 1000 })
  let calls = 0
  const fetchFn = async () => {
    calls += 1
    throw limited
  }
  const client = new to.EsploraClient({ baseUrl: 'https://esplora.example/api', fetchFn, retries: 2, sleepFn: async () => {} })
  await assert.rejects(client.getTipHeight(), error => error === limited)
  assert.equal(calls, 1, "the other build's rate_limit was retried")
}
for (const [from, to] of [[protocolCjs, protocolEsm], [protocolEsm, protocolCjs]]) {
  assert.notEqual(from.QbitProtocolError, to.QbitProtocolError, 'the two builds share one QbitProtocolError class')
  const error = thrownBy(() => from.assertMoneyRange(-1n))
  assert.equal(error instanceof to.QbitProtocolError, false)
  assert.equal(to.QbitProtocolError.is(error), true, 'QbitProtocolError.is misses the other build')
  assert.equal(to.P2mrPsbtSigningError.is(error), false)
  const failed = { inputIndex: 0, pubkey: new Uint8Array(32), leafHash: new Uint8Array(32) }
  const signing = new from.P2mrPsbtSigningError({ psbt: {}, signed: [], failed, phase: 'sign', cause: new Error('x') })
  assert.equal(to.P2mrPsbtSigningError.is(signing), true, 'P2mrPsbtSigningError.is misses the other build')
  assert.equal(to.QbitProtocolError.is(signing), true)
}
console.log('dual-build error brands: PASS')
`

const stage = mkdtempSync(join(tmpdir(), 'qbit-packed-consumer-'))
let passed = false
try {
  const consumerDir = join(stage, 'consumer')
  const modules = join(consumerDir, 'node_modules')
  mkdirSync(join(modules, '@noble'), { recursive: true })
  symlinkSync(nobleHashes, join(modules, '@noble', 'hashes'), 'dir')

  for (const dir of PACKAGE_DIRS) {
    const packDir = join(stage, `pack-${dir}`)
    mkdirSync(packDir)
    run('npm', ['pack', join(repoRoot, 'packages', dir), '--pack-destination', packDir, '--silent', '--ignore-scripts=false'])
    const tarball = readdirSync(packDir).find(file => file.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for packages/${dir}`)
    const target = join(modules, ...names[dir].split('/'))
    mkdirSync(target, { recursive: true })
    run('tar', ['-xzf', join(packDir, tarball), '-C', target, '--strip-components=1'])
    const packedName = packageName(join(target, 'package.json'))
    if (packedName !== names[dir]) {
      throw new Error(`packages/${dir} is named ${names[dir]}, but its tarball's package.json names ${packedName}`)
    }
  }

  writeFileSync(join(consumerDir, 'package.json'), `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`)
  writeFileSync(join(consumerDir, 'consumer.mts'), CONSUMER)
  writeFileSync(join(consumerDir, 'consumer.cts'), CONSUMER)
  for (const [project, env] of Object.entries(CONSUMER_PROJECTS)) {
    const tsconfig = `tsconfig.${project}.json`
    const compilerOptions = {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      noEmit: true,
      ...env,
    }
    writeFileSync(
      join(consumerDir, tsconfig),
      `${JSON.stringify({ compilerOptions, files: ['consumer.mts', 'consumer.cts'] }, null, 2)}\n`
    )
    run(process.execPath, [tscPath, '-p', tsconfig], { cwd: consumerDir })
    console.log(`${project} consumer types: PASS`)
  }

  writeFileSync(join(consumerDir, 'brand-check.mjs'), BRAND_CHECK)
  run(process.execPath, ['brand-check.mjs'], { cwd: consumerDir })
  passed = true
} finally {
  if (passed) {
    rmSync(stage, { recursive: true, force: true })
  } else {
    console.error(`packed consumer check failed; left ${stage} for inspection`)
  }
}
console.log('packed consumer check: PASS')
