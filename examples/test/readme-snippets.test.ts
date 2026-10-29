import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const checkouts: string[] = []

/** A new git repository holding the script, the READMEs it scans and the examples they copy, all tracked. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'readme-snippets-'))
  checkouts.push(root)
  const files = [
    'README.md',
    'examples/README.md',
    'examples/scripts/readme-snippets.mjs',
    ...readdirSync(join(repoRoot, 'examples/src')).map(name => `examples/src/${name}`),
    ...readdirSync(join(repoRoot, 'packages')).map(name => `packages/${name}/README.md`),
  ].filter(file => existsSync(join(repoRoot, file)))
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    cpSync(join(repoRoot, file), join(root, file))
  }
  git(root, 'init', '--quiet')
  git(root, 'add', '--all')
  return root
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
const run = (root: string, mode: '--check' | '--write') =>
  spawnSync(process.execPath, ['examples/scripts/readme-snippets.mjs', mode], { cwd: root, encoding: 'utf8' })
const check = (root: string) => run(root, '--check')
const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8')

const README = 'packages/api/README.md'
const REGION = 'examples/src/api-quick-start.ts#quick-start'

/** Give every file in `root` CRLF line endings, as a checkout with `core.autocrlf=true` does. */
function convertToCrlf(root: string): void {
  for (const file of git(root, 'ls-files', '-z').toString().split('\0').filter(Boolean)) {
    writeFileSync(join(root, file), read(root, file).replace(/\r?\n/g, '\r\n'))
  }
}

/** `markdown` with the first line of its first snippet block replaced by `stale()`. */
const withStaleBlock = (markdown: string) => {
  const stale = markdown.replace(/(<!-- snippet: [^\r\n]+\r?\n```ts\r?\n)[^\r\n]*/, '$1stale()')
  expect(stale).not.toBe(markdown)
  return stale
}

describe('readme-snippets.mjs', () => {
  afterEach(() => {
    for (const root of checkouts.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('fails on a snippet marker in a tracked Markdown file other than the READMEs it scans', () => {
    const root = checkout()
    expect(check(root).status).toBe(0)

    // A topic page whose block the script would never check.
    const page = 'packages/api/docs/guide.md'
    mkdirSync(dirname(join(root, page)), { recursive: true })
    writeFileSync(
      join(root, page),
      '# Guide\n\n<!-- snippet: examples/src/api-quick-start.ts#quick-start -->\n```ts\nstale()\n```\n'
    )
    git(root, 'add', page)
    const result = check(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${page}:3: snippet markers are read only in the READMEs`)
  })

  it('skips, with a note, a tracked Markdown file missing from the working tree', () => {
    const root = checkout()
    // Deleted from disk, but not yet with `git rm`, so git still lists it.
    const page = 'packages/api/docs/guide.md'
    mkdirSync(dirname(join(root, page)), { recursive: true })
    writeFileSync(join(root, page), '# Guide\n')
    git(root, 'add', page)
    rmSync(join(root, page))

    const result = check(root)

    expect(result.stderr).toContain(`note: skipped ${page}: git tracks it, but it is not in the working tree`)
    expect(result.status).toBe(0)

    // A marker in another tracked file still fails the check.
    const other = 'packages/api/docs/other.md'
    writeFileSync(join(root, other), '<!-- snippet: examples/src/api-quick-start.ts#quick-start -->\n')
    git(root, 'add', other)

    const failed = check(root)

    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain(`${other}:1: snippet markers are read only in the READMEs`)
  })

  it('checks a CRLF checkout, and a README whose lines end in a mix of CRLF and LF', () => {
    const root = checkout()
    convertToCrlf(root)

    expect(check(root).status).toBe(0)

    // An editor wrote the block, its marker and fences with LF endings into the CRLF README.
    const lines = read(root, README).split(/(?<=\n)/)
    const marker = lines.findIndex(line => line.startsWith('<!-- snippet: '))
    const close = lines.findIndex((line, index) => index > marker + 1 && line.startsWith('```'))
    for (let index = marker; index <= close; index += 1) lines[index] = lines[index]!.replace(/\r\n$/, '\n')
    writeFileSync(join(root, README), lines.join(''))

    expect(check(root).status).toBe(0)

    // A block that differs from its region still fails, at the line that differs.
    writeFileSync(join(root, README), withStaleBlock(lines.join('')))
    const stale = check(root)

    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain(`${README}:${marker + 3}: the block differs from ${REGION}`)
  })

  it('writes a README with the line ending most of its lines use, and never \\r\\r\\n', () => {
    const root = checkout()
    convertToCrlf(root)
    const current = read(root, README)

    // A CRLF checkout, with CRLF examples: the rewritten block ends in CRLF too.
    writeFileSync(join(root, README), withStaleBlock(current))

    expect(run(root, '--write').status).toBe(0)
    expect(read(root, README)).toBe(current)

    // An LF README with one line pasted with CRLF: what --write writes ends in LF.
    const lf = current.replace(/\r\n/g, '\n')
    writeFileSync(join(root, README), withStaleBlock(lf.replace('\n', '\r\n')))

    expect(run(root, '--write').status).toBe(0)
    expect(read(root, README)).toBe(lf)
    expect(check(root).status).toBe(0)

    // A README whose blocks match is left as it is, whatever its line endings.
    const mixed = lf.replace('\n', '\r\n')
    writeFileSync(join(root, README), mixed)

    expect(run(root, '--write').status).toBe(0)
    expect(read(root, README)).toBe(mixed)
  })
})
