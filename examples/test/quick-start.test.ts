import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type EsploraUtxo } from '@qbit-oss/api'
import {
  addressToScriptPubKey,
  bytesToHex,
  psbtUnsignedTransaction,
  validateP2mrSigningPlans,
} from '@qbit-oss/protocol'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stubEsplora } from './stub-esplora'

// The address both quick starts name: the one the protocol quick start derives from its placeholder key.
const ADDRESS = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'

/** An esplora backend for ADDRESS, as the global fetch, and what the api quick start should print. */
function stubApiBackend() {
  const utxos: EsploraUtxo[] = [
    { txid: 'a1'.repeat(32), vout: 0, value: 150_000, status: { confirmed: true, block_height: 120 } },
  ]
  const funding = {
    txid: 'a1'.repeat(32),
    status: { confirmed: true, block_height: 120 },
    vin: [],
    vout: [{ scriptpubkey_address: ADDRESS, value: 150_000 }],
  }
  const esplora = stubEsplora({
    address: ADDRESS,
    confirmedSats: 150_000,
    utxos,
    history: { confirmed: [funding], mempool: [] },
    feeEstimates: { '6': 2, '1': 12.5, '3': 5 },
  })
  vi.stubGlobal('fetch', esplora.fetchFn)
  return {
    balance: { address: ADDRESS, confirmedSats: 150_000, mempoolSats: 0, totalSats: 150_000 },
    utxos,
    history: { confirmed: [funding], mempool: [] },
    fees: [
      { target: 1, feeRate: 12.5 },
      { target: 3, feeRate: 5 },
      { target: 6, feeRate: 2 },
    ],
  }
}

/** The first value logged with console.log; rejects with the first console.error instead. */
function firstLog(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    vi.spyOn(console, 'log').mockImplementation(value => resolve(value))
    vi.spyOn(console, 'error').mockImplementation(error => reject(error))
  })
}

/** The code block a README copies from an example, as a user would paste it. */
function readmeBlock(readme: string): string {
  const lines = readFileSync(new URL(`../../${readme}`, import.meta.url), 'utf8').split('\n')
  const start = lines.findIndex(line => line.startsWith('<!-- snippet: ')) + 2
  return lines.slice(start, lines.indexOf('```', start)).join('\n')
}

/** Compile `source` as a CommonJS TypeScript project does, then run it with Node's require. */
function runAsCommonJs(source: string): void {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  })
  const module = { exports: {} }
  // A top-level await is a SyntaxError here, as it is in a CommonJS module.
  new Function('require', 'module', 'exports', outputText)(createRequire(import.meta.url), module, module.exports)
}

/**
 * The type errors in `source` in a strict browser project, `lib: ["ES2022",
 * "DOM"]` and no `@types/node`, as the api README supports, so that a Node
 * global such as `process` is an error. The file sits in examples/, never
 * written, and resolves the packages through their built declarations.
 */
function browserTypeErrors(source: string): string[] {
  const examples = fileURLToPath(new URL('..', import.meta.url))
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      types: [],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    examples
  )
  expect(errors).toEqual([])
  const file = join(examples, 'browser-quick-start.ts')
  const host = ts.createCompilerHost(options)
  const { fileExists, getSourceFile, readFile } = host
  host.fileExists = path => path === file || fileExists(path)
  host.readFile = path => (path === file ? source : readFile(path))
  host.getSourceFile = (path, ...rest) =>
    path === file ? ts.createSourceFile(path, source, ts.ScriptTarget.ES2022) : getSourceFile(path, ...rest)
  const program = ts.createProgram([file], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map(({ file, start, messageText }) =>
      [
        file && start !== undefined && `${file.fileName}:${file.getLineAndCharacterOfPosition(start).line + 1}`,
        ts.flattenDiagnosticMessageText(messageText, '\n'),
      ]
        .filter(Boolean)
        .join(': ')
    )
}

describe('README quick starts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("runs the api README's against the endpoint it names, through the global fetch", async () => {
    const expected = stubApiBackend()
    const logged = firstLog()

    await import('../src/api-quick-start')

    expect(await logged).toEqual(expected)
  })

  it("builds the protocol README's PSBT for the address it names, with plans that validate", async () => {
    const { address, fundingTxid, keys, psbt } = await import('../src/protocol-quick-start')

    expect(address).toBe(ADDRESS)
    const tx = psbtUnsignedTransaction(psbt)
    expect(tx.inputs).toHaveLength(1)
    // The prevout holds fundingTxid in internal byte order, and vout 0.
    expect(bytesToHex(tx.inputs[0]!.prevout.txid.slice().reverse())).toBe(fundingTxid)
    expect(tx.inputs[0]!.prevout.vout).toBe(0)
    expect(tx.outputs).toEqual([{ value: 99_000n, scriptPubKey: addressToScriptPubKey(ADDRESS, 'regtest') }])
    expect(() => validateP2mrSigningPlans({ psbt, keys })).not.toThrow()
  })

  it("runs both as pasted into a CommonJS project, through each package's CommonJS build", async () => {
    const expected = stubApiBackend()
    const logged = firstLog()

    runAsCommonJs(readmeBlock('packages/api/README.md'))
    expect(await logged).toEqual(expected)

    expect(() => runAsCommonJs(readmeBlock('packages/protocol/README.md'))).not.toThrow()
  })

  it("type-checks the api README's in a browser project, with the DOM library and no @types/node", () => {
    expect(browserTypeErrors(readmeBlock('packages/api/README.md'))).toEqual([])
  })
})
