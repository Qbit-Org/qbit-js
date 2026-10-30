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
//    `lib/index.d.ts` are checked, and likewise `@qbit-oss/api/testing`'s
//    `lib/testing.d.mts` and `lib/testing.d.ts`. Two more projects import
//    `@qbit-oss/api` and `@qbit-oss/api/testing` from a `.ts` file: one with
//    `moduleResolution: "node10"`, which ignores `exports` and finds the
//    subpath through the `testing/package.json` shim's `types`, and one with
//    `"bundler"`. Each project is checked by one `tsc --listFiles` run and
//    must resolve exactly the `lib/*.d.*` files listed for it, so neither the
//    shim nor `exports` can send an import to the wrong file.
// 2. Loads the CommonJS and the ESM build side by side and checks that each
//    error class's `is()` recognizes an error from the other build, where
//    `instanceof` cannot, and that a client passes a `fetchFn`'s error from
//    the other build through as it is.
// 3. Loads `@qbit-oss/api/testing` from both builds, checks that a mock from
//    either drives a client from either, and that `lib/testing.*` holds no
//    copy of `QbitApiError`: the testing build must import nothing from the
//    client at runtime.
// 4. Loads `@qbit-oss/api/testing` from a copy of the package without its
//    `exports` field, as resolvers that ignore it see the package (Jest
//    before 28 and Metro without package exports resolve it through `main`):
//    `require` must find the CommonJS build through the `testing/package.json`
//    shim's `main`, whose `module` and `types` name the ESM build and the
//    declarations.
//
// Package names, and so the install paths and import specifiers, come from
// each package's package.json, and must match the name in its tarball.
//
// Works offline: TypeScript, `@types/node` and `@noble/hashes` come from this
// workspace's install, at the versions the lockfile pins.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
const apiTesting = JSON.stringify(`${names.api}/testing`)
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
import { createMockEsplora, type MockEsplora, type MockFault } from ${apiTesting}
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

const faults: MockFault[] = [
  { route: 'GET /blocks/tip/height', kind: 'status', status: 429, retryAfter: 1 },
  { route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' },
]
const mock: MockEsplora = createMockEsplora({ backend: 'mempool-qbit', faults })
export const mocked = new MempoolQbitClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn })

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

/** Both entry points from a plain `.ts` file, for the `node10` and `bundler` projects. */
const SUBPATH_CONSUMER = `
import { EsploraClient, type EsploraClientOptions } from ${api}
import { createMockEsplora, type MockFault } from ${apiTesting}

const faults: MockFault[] = [{ route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' }]
const mock = createMockEsplora({ backend: 'esplora', faults })
const options: EsploraClientOptions = { baseUrl: mock.baseUrl, fetchFn: mock.fetchFn }
export const client = new EsploraClient(options)
`

const NODE_ONLY = { lib: ['ES2022'], types: ['node'], typeRoots: [typeRoot] }
const NODE_NEXT = { module: 'NodeNext', moduleResolution: 'NodeNext' }
/** Each project's compiler options, files, and the `@qbit-oss/api` declarations it must resolve. */
const CONSUMER_PROJECTS = {
  node: {
    env: { ...NODE_NEXT, ...NODE_ONLY },
    files: ['consumer.mts', 'consumer.cts'],
    api: ['index.d.mts', 'index.d.ts', 'testing.d.mts', 'testing.d.ts'],
  },
  browser: {
    env: { ...NODE_NEXT, lib: ['ES2022', 'DOM'], types: [] },
    files: ['consumer.mts', 'consumer.cts'],
    api: ['index.d.mts', 'index.d.ts', 'testing.d.mts', 'testing.d.ts'],
  },
  node10: {
    env: { module: 'CommonJS', moduleResolution: 'node10', ...NODE_ONLY },
    files: ['consumer-subpath.ts'],
    api: ['index.d.ts', 'testing.d.ts'],
  },
  bundler: {
    env: { module: 'ESNext', moduleResolution: 'bundler', ...NODE_ONLY },
    files: ['consumer-subpath.ts'],
    api: ['index.d.mts', 'testing.d.mts'],
  },
}

const BRAND_CHECK = `
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as apiEsm from ${api}
import * as protocolEsm from ${protocol}
import * as testingEsm from ${apiTesting}

const require = createRequire(import.meta.url)
const apiCjs = require(${api})
const protocolCjs = require(${protocol})
const testingCjs = require(${apiTesting})

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

// The genesis coinbase transaction and its txid, which both builds of the
// testing entry point derive with @noble/hashes.
const TX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'
const TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
assert.notEqual(testingEsm.createMockEsplora, testingCjs.createMockEsplora, 'the two builds share one testing module')
for (const testing of [testingEsm, testingCjs]) {
  assert.equal('QbitApiError' in testing, false, 'the testing entry point re-exports the client')
  for (const client of [apiEsm, apiCjs]) {
    const mock = testing.createMockEsplora({
      backend: 'mempool-qbit',
      faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' }],
    })
    const mempool = new client.MempoolQbitClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn, sleepFn: async () => {} })
    await assert.rejects(mempool.getTxStatus(TXID), error => client.QbitApiError.is(error) && error.kind === 'not_found')
    await assert.rejects(
      mempool.broadcastTx(TX),
      error => client.QbitApiError.is(error) && error.kind === 'unknown_outcome' && error.txid === TXID
    )
    assert.deepEqual(await mempool.getTxStatus(TXID), { confirmed: false })
    assert.equal((await mempool.getTx(TXID)).vin[0].is_coinbase, true, 'the mock serves the coinbase it took as a spend')
  }
}
// esbuild emits the class as \`var QbitApiError = class extends Error\`, names it
// (\`class QbitApiError\`, \`class _QbitApiError\`) when it keeps or refers to its
// name, and renames a clash with a number (\`QbitApiError2\`).
const CLASS_DEFINITION = /\\bclass\\s+_*QbitApiError\\d*\\b|\\bQbitApiError\\d*\\s*=\\s*class\\b/
const apiLib = dirname(require.resolve(${api}))
for (const name of ['index.js', 'index.mjs']) {
  assert.ok(CLASS_DEFINITION.test(readFileSync(join(apiLib, name), 'utf8')), \`the guard misses QbitApiError in lib/\${name}\`)
}
for (const file of readdirSync(apiLib).filter(name => name.startsWith('testing.'))) {
  const text = readFileSync(join(apiLib, file), 'utf8')
  assert.equal(CLASS_DEFINITION.test(text), false, \`lib/\${file} defines QbitApiError\`)
  assert.equal(text.includes('qbit-js.QbitApiError'), false, \`lib/\${file} carries the QbitApiError brand\`)
}
console.log('testing entry point, both builds: PASS')
`

/** Run from a project whose copy of the api package has no \`exports\`, as a resolver that ignores it sees the package. */
const NO_EXPORTS_CHECK = `
const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { join, relative } = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const manifest = require(${JSON.stringify(`${names.api}/package.json`)})
  assert.equal('exports' in manifest, false, 'this copy still has exports')
  const apiDir = join(require.resolve(${JSON.stringify(`${names.api}/package.json`)}), '..')
  assert.equal(relative(apiDir, require.resolve(${apiTesting})), join('lib', 'testing.js'))
  const testing = require(${apiTesting})
  const { EsploraClient } = require(${api})
  const mock = testing.createMockEsplora({ backend: 'esplora', tip: { height: 7 } })
  const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn })
  assert.equal(await client.getTipHeight(), 7)

  const shimDir = join(apiDir, 'testing')
  const shim = require(join(shimDir, 'package.json'))
  assert.equal(relative(apiDir, join(shimDir, shim.types)), join('lib', 'testing.d.ts'))
  assert.ok(existsSync(join(shimDir, shim.types)), 'the shim names missing declarations')
  const esm = await import(pathToFileURL(join(shimDir, shim.module)).href)
  assert.equal(relative(apiDir, join(shimDir, shim.module)), join('lib', 'testing.mjs'))
  assert.equal(typeof esm.createMockEsplora, 'function')
  console.log('testing entry point without exports, through testing/package.json: PASS')
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
`

/** One \`tsc --listFiles\` run: type-checks the project and returns the files it compiled. */
function typeCheck(tsconfig, cwd) {
  console.log(`+ ${process.execPath} ${tscPath} -p ${tsconfig} --listFiles  (cwd: ${cwd})`)
  try {
    return execFileSync(process.execPath, [tscPath, '-p', tsconfig, '--listFiles'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } catch (error) {
    // tsc writes its diagnostics to stdout, among the files it lists.
    const diagnostics = String(error.stdout ?? '')
      .split('\n')
      .filter(line => line !== '' && !existsSync(line))
    console.error(diagnostics.join('\n'))
    throw error
  }
}

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
    run('npm', [
      'pack',
      join(repoRoot, 'packages', dir),
      '--pack-destination',
      packDir,
      '--silent',
      '--ignore-scripts=false',
    ])
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
  writeFileSync(join(consumerDir, 'consumer-subpath.ts'), SUBPATH_CONSUMER)
  const apiLib = join(modules, ...names.api.split('/'), 'lib')
  for (const [project, { env, files, api: expected }] of Object.entries(CONSUMER_PROJECTS)) {
    const tsconfig = `tsconfig.${project}.json`
    const compilerOptions = {
      target: 'ES2022',
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      noEmit: true,
      ...env,
    }
    writeFileSync(join(consumerDir, tsconfig), `${JSON.stringify({ compilerOptions, files }, null, 2)}\n`)
    const resolved = typeCheck(tsconfig, consumerDir)
      .split('\n')
      .filter(file => file.startsWith(`${realpathSync(apiLib)}/`))
      .map(file => file.slice(realpathSync(apiLib).length + 1))
      .sort()
    if (JSON.stringify(resolved) !== JSON.stringify([...expected].sort())) {
      throw new Error(
        `${project} consumer resolved ${names.api} lib/${resolved.join(', lib/')}, not lib/${expected.join(', lib/')}`
      )
    }
    console.log(`${project} consumer types (lib/${resolved.join(', lib/')}): PASS`)
  }

  writeFileSync(join(consumerDir, 'brand-check.mjs'), BRAND_CHECK)
  run(process.execPath, ['brand-check.mjs'], { cwd: consumerDir })

  // Inside consumerDir, so the copy still finds @noble/hashes in consumerDir/node_modules.
  const noExportsDir = join(consumerDir, 'no-exports')
  const noExportsApi = join(noExportsDir, 'node_modules', ...names.api.split('/'))
  cpSync(join(modules, ...names.api.split('/')), noExportsApi, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(noExportsApi, 'package.json'), 'utf8'))
  delete manifest.exports
  writeFileSync(join(noExportsApi, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(noExportsDir, 'no-exports-check.cjs'), NO_EXPORTS_CHECK)
  run(process.execPath, ['no-exports-check.cjs'], { cwd: noExportsDir })
  passed = true
} finally {
  if (passed) {
    rmSync(stage, { recursive: true, force: true })
  } else {
    console.error(`packed consumer check failed; left ${stage} for inspection`)
  }
}
console.log('packed consumer check: PASS')
