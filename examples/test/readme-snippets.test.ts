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
  copyTree(root)
  git(root, 'init', '--quiet')
  git(root, 'add', '--all')
  return root
}

/** Copy the script, the READMEs it scans and the examples they copy into `root`. */
function copyTree(root: string): void {
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
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
/** `env` as on a contributor's machine: without `CI`, under which the script must scan every tracked Markdown file. */
const local = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { CI: _ci, ...rest } = env
  return rest
}
const run = (root: string, mode: '--check' | '--write', env: NodeJS.ProcessEnv = local()) =>
  spawnSync(process.execPath, ['examples/scripts/readme-snippets.mjs', mode], { cwd: root, encoding: 'utf8', env })
const check = (root: string, env?: NodeJS.ProcessEnv) => run(root, '--check', env)
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

  it('checks the READMEs without git, or outside a git checkout, and skips only the scan of other Markdown files', () => {
    // A source tarball or a Docker context: the files, but no .git. Git must
    // not find a repository above the copy either.
    const unpacked = checkout()
    rmSync(join(unpacked, '.git'), { recursive: true, force: true })
    const outside = { ...local(), GIT_CEILING_DIRECTORIES: dirname(unpacked) }
    // A checkout on a machine without git.
    const gitless = checkout()
    const noGit = { ...local(), PATH: join(gitless, 'no-git-here') }

    for (const [root, env, reason] of [
      [unpacked, outside, 'git ls-files failed: '],
      [gitless, noGit, 'git is not installed'],
    ] as const) {
      const result = check(root, env)

      expect(result.status, reason).toBe(0)
      expect(result.stderr, reason).toContain(
        `note: skipped the scan of other Markdown files for snippet markers: ${reason}`
      )

      // A block that differs from its region still fails.
      writeFileSync(join(root, README), withStaleBlock(read(root, README)))
      const stale = check(root, env)

      expect(stale.status, reason).toBe(1)
      expect(stale.stderr, reason).toContain(`the block differs from ${REGION}`)
    }
  })

  it('skips the scan of other Markdown files, with a note, in a tree unpacked inside another git checkout', () => {
    // A source tarball unpacked inside some other project's checkout, which
    // tracks none of its files: `git ls-files` there succeeds, listing none.
    const outer = checkout()
    const unpacked = join(outer, 'vendor', 'qbit-js')
    copyTree(unpacked)
    // A marker in a Markdown file the scan would have read, had git tracked it.
    const page = join(unpacked, 'packages/api/docs/guide.md')
    mkdirSync(dirname(page), { recursive: true })
    writeFileSync(page, '<!-- snippet: examples/src/api-quick-start.ts#quick-start -->\n')

    const result = check(unpacked)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain(
      'note: skipped the scan of other Markdown files for snippet markers: git does not track this tree: git ls-files does not list examples/scripts/readme-snippets.mjs'
    )

    // The READMEs are still checked: a block that differs from its region fails.
    writeFileSync(join(unpacked, README), withStaleBlock(read(unpacked, README)))
    const stale = check(unpacked)

    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain(`the block differs from ${REGION}`)
  })

  it('scans the other Markdown files of a tree that another git checkout tracks', () => {
    // qbit-js committed inside another project's repository: `git ls-files`,
    // run at its root, lists its files.
    const outer = checkout()
    const vendored = join(outer, 'vendor', 'qbit-js')
    copyTree(vendored)
    git(outer, 'add', '--all')

    const result = check(vendored)

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('note: skipped the scan')

    // A marker in another tracked Markdown file fails the check.
    const page = 'packages/api/docs/guide.md'
    mkdirSync(dirname(join(vendored, page)), { recursive: true })
    writeFileSync(join(vendored, page), '<!-- snippet: examples/src/api-quick-start.ts#quick-start -->\n')
    git(outer, 'add', '--all')

    const failed = check(vendored)

    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain(`${page}:1: snippet markers are read only in the READMEs`)
  })

  it('skips the scan of other Markdown files, with a note, whatever makes git ls-files fail or list nothing', () => {
    // A corrupt index, which `git ls-files` cannot read.
    const corrupt = checkout()
    writeFileSync(join(corrupt, '.git', 'index'), 'not an index\n')
    // A bare repository as GIT_DIR, which has no work tree: `git ls-files`
    // lists nothing there.
    const bare = mkdtempSync(join(tmpdir(), 'readme-snippets-bare-'))
    checkouts.push(bare)
    git(bare, 'init', '--quiet', '--bare')
    const noWorkTree = checkout()

    for (const [root, env, reason] of [
      [corrupt, undefined, 'git ls-files failed: '],
      [noWorkTree, { ...local(), GIT_DIR: bare }, 'git does not track this tree: '],
    ] as const) {
      const result = check(root, env)

      expect(result.status, reason).toBe(0)
      expect(result.stderr, reason).toContain(
        `note: skipped the scan of other Markdown files for snippet markers: ${reason}`
      )

      // A block that differs from its region still fails.
      writeFileSync(join(root, README), withStaleBlock(read(root, README)))
      const stale = check(root, env)

      expect(stale.status, reason).toBe(1)
      expect(stale.stderr, reason).toContain(`the block differs from ${REGION}`)
    }
  })

  it('fails instead of skipping the scan of other Markdown files in CI', () => {
    // A checkout on a CI runner without git: the scan cannot run, which must
    // not pass unnoticed there.
    const root = checkout()
    const noGit = { ...local(), PATH: join(root, 'no-git-here') }

    for (const ci of ['true', '1']) {
      const result = check(root, { ...noGit, CI: ci })

      expect(result.status, ci).toBe(1)
      expect(result.stderr, ci).toContain(
        'the scan of other Markdown files for snippet markers must run in CI, but: git is not installed'
      )
    }
    for (const ci of ['', '0', 'false', 'FALSE']) {
      const result = check(root, { ...noGit, CI: ci })

      expect(result.status, ci).toBe(0)
      expect(result.stderr, ci).toContain('note: skipped the scan of other Markdown files for snippet markers')
    }
    // With git, CI changes nothing.
    expect(check(root, { ...local(), CI: 'true' }).status).toBe(0)
  })

  it('prints every problem and difference, a scan CI cannot run included, and --write then rewrites nothing', () => {
    // A block that differs from its region, and a marker the script cannot read.
    const root = checkout()
    const stale = withStaleBlock(read(root, README))
    writeFileSync(join(root, README), stale)
    const examples = `${read(root, 'examples/README.md')}\n<!--snippet: examples/src/send-payment.ts#broadcast -->\n`
    writeFileSync(join(root, 'examples/README.md'), examples)
    const unreadable = 'a snippet marker must be a whole line'

    const written = run(root, '--write')

    expect(written.status).toBe(1)
    expect(written.stderr).toContain(unreadable)
    expect(read(root, README)).toBe(stale)

    // On a CI runner without git, where the scan of other Markdown files cannot run.
    const ci = { ...local(), PATH: join(root, 'no-git-here'), CI: 'true' }
    const scan = 'the scan of other Markdown files for snippet markers must run in CI, but: git is not installed'
    for (const result of [check(root, ci), run(root, '--write', ci)]) {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(scan)
      expect(result.stderr).toContain(unreadable)
    }
    expect(check(root, ci).stderr).toContain(`the block differs from ${REGION}`)
    expect(read(root, README)).toBe(stale)
    expect(read(root, 'examples/README.md')).toBe(examples)
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

  it('writes a block with the line ending most of its README uses, and never \\r\\r\\n', () => {
    const root = checkout()
    convertToCrlf(root)
    const current = read(root, README)

    // A CRLF checkout, with CRLF examples: the rewritten block ends in CRLF too.
    writeFileSync(join(root, README), withStaleBlock(current))

    expect(run(root, '--write').status).toBe(0)
    expect(read(root, README)).toBe(current)

    // A README whose blocks match is left as it is, whatever its line endings.
    const mixed = current.replace(/\r\n/g, '\n').replace('\n', '\r\n')
    writeFileSync(join(root, README), mixed)

    expect(run(root, '--write').status).toBe(0)
    expect(read(root, README)).toBe(mixed)
  })

  it('keeps every line outside a block it rewrites as it was, ending included', () => {
    const root = checkout()
    const lines = read(root, README)
      .replace(/\r\n/g, '\n')
      .split(/(?<=\n)/)
    const marker = lines.findIndex(line => line.startsWith('<!-- snippet: '))
    const close = lines.findIndex((line, index) => index > marker + 1 && line.startsWith('```'))
    const lf = (line: string) => line
    const crlf = (line: string) => line.replace(/\n$/, '\r\n')
    const endsOtherwise = (index: number) => index === 0 || index === marker || index === close
    const inBlock = (index: number) => index > marker + 1 && index < close

    // Most lines end in LF, then in CRLF. The title, the marker and the closing
    // fence end in the other, and so do the block's lines until --write
    // rewrites them with the ending most lines use.
    for (const [usual, other] of [
      [lf, crlf],
      [crlf, lf],
    ] as const) {
      const written = lines.map((line, index) => (endsOtherwise(index) ? other(line) : usual(line))).join('')
      const stale = lines
        .map((line, index) => (endsOtherwise(index) || inBlock(index) ? other(line) : usual(line)))
        .join('')
      writeFileSync(join(root, README), withStaleBlock(stale))

      expect(run(root, '--write').status).toBe(0)
      expect(read(root, README)).toBe(written)
      expect(check(root).status).toBe(0)
    }
  })
})
