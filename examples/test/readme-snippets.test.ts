import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const check = (root: string) =>
  spawnSync(process.execPath, ['examples/scripts/readme-snippets.mjs', '--check'], { cwd: root, encoding: 'utf8' })

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
})
