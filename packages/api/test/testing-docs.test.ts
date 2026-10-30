import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import * as api from '../src/index'
import * as testing from '../src/testing'

// docs/testing.md's Quick start, run as written, so that neither its code nor
// the values its comments give can drift from the kit. A line with code and a
// trailing comment is an expression whose value the comment gives: the test
// records each value with the comment's text, and CLAIMS checks it.

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')

/** A real P2MR transaction, as the Quick start's `signedTxHex`. */
const P2MR_TX = JSON.parse(readFileSync(new URL('./fixtures/p2mr-witness-tx.json', import.meta.url), 'utf8')) as {
  rawTxHex: string
  txid: string
}

interface Scope {
  mock: testing.MockEsplora
  client: api.EsploraClient
  address: string
}

/** What each comment says, by its exact text, in the order of the Quick start. */
const CLAIMS: Record<string, (value: unknown, scope: Scope) => unknown> = {
  '{ address, confirmedSats: 150000, mempoolSats: 0, totalSats: 150000 }': (value, { address }) =>
    expect(value).toEqual({ address, confirmedSats: 150_000, mempoolSats: 0, totalSats: 150_000 }),
  "[{ txid: 'a1a1...', vout: 0, value: 150000, status: { confirmed: true, ... } }]": value =>
    expect(value).toEqual([
      { txid: 'a1'.repeat(32), vout: 0, value: 150_000, status: expect.objectContaining({ confirmed: true }) },
    ]),
  'true: getTx finds it too': async (value, { client }) => {
    expect(value).toBe(true)
    await expect(client.getTx(P2MR_TX.txid)).resolves.toMatchObject({ txid: P2MR_TX.txid })
  },
  "[`GET /address/${address}`, `GET /address/${address}/utxo`, 'POST /tx']": (value, { address }) =>
    expect(value).toEqual([`GET /address/${address}`, `GET /address/${address}/utxo`, 'POST /tx']),
  "{ method: 'POST', url: 'https://esplora.example/api/tx', path: '/tx', body: signedTxHex }": value =>
    expect(value).toEqual({
      method: 'POST',
      url: 'https://esplora.example/api/tx',
      path: '/tx',
      body: P2MR_TX.rawTxHex,
    }),
}

/** The first `ts` block under `## Quick start`. */
function quickStart(): string {
  const doc = readFileSync(new URL('../docs/testing.md', import.meta.url), 'utf8')
  const block = /^## Quick start\r?\n\r?\n```ts\r?\n([\s\S]*?)^```\r?$/m.exec(doc)
  if (block === null) throw new Error('docs/testing.md has no ts block under ## Quick start')
  return block[1]!
}

/**
 * Run `block` as the body of an async function, compiled to CommonJS so that
 * its imports of the two entry points load the sources, recording each
 * commented value as `[comment, value]`.
 */
async function run(block: string, signedTxHex: string): Promise<{ recorded: [string, unknown][]; scope: Scope }> {
  const recording = block
    .split(/\r?\n/)
    .map(line => {
      const claim = /^(\s*)([^\s/].*?)\s+\/\/ (.+)$/.exec(line)
      return claim === null ? line : `${claim[1]}recorded.push([${JSON.stringify(claim[3])}, ${claim[2]}])`
    })
    .join('\n')
  const { outputText } = ts.transpileModule(recording, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const modules: Record<string, unknown> = { '@qbit-oss/api': api, '@qbit-oss/api/testing': testing }
  const load = (specifier: string): unknown => {
    if (!Object.prototype.hasOwnProperty.call(modules, specifier)) throw new Error(`unexpected import ${specifier}`)
    return modules[specifier]
  }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...parameters: string[]
  ) => (...args: unknown[]) => Promise<unknown>
  const body = `${outputText}\nreturn { mock, client, address }`
  const recorded: [string, unknown][] = []
  const scope = await new AsyncFunction('require', 'exports', 'recorded', 'signedTxHex', body)(
    load,
    {},
    recorded,
    signedTxHex
  )
  return { recorded, scope: scope as Scope }
}

describe('docs/testing.md', () => {
  it('runs the Quick start as written, and each line gives the value its comment says', async () => {
    const { recorded, scope } = await run(quickStart(), P2MR_TX.rawTxHex)
    expect(recorded.map(([comment]) => comment)).toEqual(Object.keys(CLAIMS))
    for (const [comment, value] of recorded) await CLAIMS[comment]!(value, scope)
  })
})
