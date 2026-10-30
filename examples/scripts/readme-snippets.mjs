#!/usr/bin/env node
// Keep README code blocks in step with the examples they are copied from.
//
// A README embeds a region of an example by putting a marker on the line
// before a fenced block:
//
//   <!-- snippet: examples/src/api-quick-start.ts#quick-start -->
//   ```ts
//   ...
//   ```
//
// The marker starts its line, and the block ends at the first following line
// that starts with a fence, which must be exactly ```. The path is relative to
// the repository root and must be under examples/.
// The block holds the lines between `// #region quick-start` and
// `// #endregion quick-start` in that file, dedented. A region may be split
// into several parts, for example an import at the top of the file and code
// in a function; the parts are joined with a blank line. Region marker lines
// themselves are never copied.
//
// EXPECTED lists every embedded block. A marker that is missing from its
// README, or that is not listed, fails both modes, so deleting a marker cannot
// leave its block silently unchecked.
//
// Only the READMEs are scanned: README.md, examples/README.md and
// packages/*/README.md. A marker in any other Markdown file that git tracks
// fails both modes too, since its block would never be checked. Those files
// are listed with `git ls-files`, run at the repository root, which lists the
// files git tracks under it, whether the root is a checkout of its own or a
// tracked part of another one, and they are scanned when the list includes
// this script. Otherwise that scan alone is skipped with a note, and the
// READMEs are still checked: when git is missing, when `git ls-files` fails
// for any reason, such as outside any checkout, or when the list does not
// include this script, as in a source tarball unpacked inside another
// checkout. In CI (the CI environment variable set, and not to 0 or false),
// the scan must run, so any of those reasons is a problem there, which fails
// both modes instead. A tracked file missing from the working tree, deleted
// but not yet removed with `git rm`, holds no marker: it is skipped with a
// note.
//
// Every problem and every difference found is printed. --write rewrites
// nothing until every check has passed, so a run that fails leaves the
// READMEs as they were.
//
// Line endings do not count, so a CRLF checkout, or a README whose lines end
// in a mix of CRLF and LF, checks the same as an LF one. --write keeps every
// line outside the blocks it changes as it was, ending included, and ends the
// lines it writes with the line ending most of the README's lines use.
//
//   node examples/scripts/readme-snippets.mjs --check   exit 1 if a block is out of date
//   node examples/scripts/readme-snippets.mjs --write   rewrite the blocks that are
//
// The examples' `test` script runs --check. The script has no dependencies.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
/** This script, as `git ls-files` lists it when git tracks this tree. */
const SCRIPT = 'examples/scripts/readme-snippets.mjs'
/** Whether this runs in CI, where the scan of other Markdown files must not be skipped. */
const inCi = !/^(|0|false)$/i.test(process.env.CI ?? '')
const MARKER = /^<!-- snippet: (\S+)#([\w-]+) -->$/
/** Any line that starts like a marker, readable or not. */
const MARKER_START = /^\s*<!--\s*snippet\b/
const REGION = /^\s*\/\/ #(region|endregion) ([\w-]+)\s*$/

/** Every embedded block, as `<README>: <source>#<region>`. */
const EXPECTED = [
  'packages/api/README.md: examples/src/api-quick-start.ts#quick-start',
  'packages/protocol/README.md: examples/src/protocol-quick-start.ts#quick-start',
  'examples/README.md: examples/src/send-payment.ts#broadcast',
]

const mode = process.argv.slice(2).join(' ')
if (mode !== '--check' && mode !== '--write') {
  console.error('usage: node examples/scripts/readme-snippets.mjs --check | --write')
  process.exit(2)
}

const readmes = [
  'README.md',
  'examples/README.md',
  ...readdirSync(join(repoRoot, 'packages')).map(name => `packages/${name}/README.md`),
].filter(path => existsSync(join(repoRoot, path)))

/** The blocks found, in the same form as EXPECTED. */
const found = []
/** Blocks that differ from their region; --write fixes these. */
const drift = []
/** Markers that cannot be resolved, and a scan that must run in CI but cannot. */
const problems = []
/** The READMEs --write rewrites, with their new text, once every check has passed. */
const rewrites = []
for (const readme of readmes) {
  const original = readFileSync(join(repoRoot, readme), 'utf8')
  // The lines without their endings, each line's own ending, which --write
  // keeps outside the blocks it changes, and the ending most lines use, which
  // it gives the lines it writes.
  const lines = original.split(/\r?\n/)
  const endings = original.match(/\r?\n/g) ?? []
  endings.push('') // the last line has none
  const crlf = endings.filter(ending => ending === '\r\n').length
  const eol = crlf > endings.length - 1 - crlf ? '\r\n' : '\n'
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const marker = MARKER.exec(lines[index])
    const where = `${readme}:${index + 1}`
    if (marker === null) {
      // A marker this script cannot read must fail, not leave its block unchecked.
      if (MARKER_START.test(lines[index])) {
        problems.push(`${where}: a snippet marker must be a whole line: <!-- snippet: examples/<file>#<region> -->`)
      }
      continue
    }
    const [, source, name] = marker
    found.push(`${readme}: ${source}#${name}`)
    if (!/^```\w*$/.test(lines[index + 1] ?? '')) {
      problems.push(`${where}: the snippet marker must be followed by an opening fence`)
      continue
    }
    const start = index + 2
    const end = lines.findIndex((line, i) => i >= start && /^\s*```/.test(line))
    if (end === -1 || lines[end] !== '```') {
      problems.push(`${where}: the block after the snippet marker must end with a line that is exactly \`\`\``)
      continue
    }
    let expected
    try {
      expected = readRegion(source, name)
    } catch (error) {
      problems.push(`${where}: ${error.message}`)
      continue
    }
    const actual = lines.slice(start, end)
    const differs = actual.findIndex((line, i) => line !== expected[i])
    const first = differs === -1 ? Math.min(actual.length, expected.length) : differs
    if (actual.length !== expected.length || differs !== -1) {
      drift.push(
        `${readme}:${start + first + 1}: the block differs from ${source}#${name}\n` +
          `  README:  ${JSON.stringify(actual[first] ?? '(block ends)')}\n` +
          `  example: ${JSON.stringify(expected[first] ?? '(region ends)')}`
      )
      lines.splice(start, end - start, ...expected)
      endings.splice(start, end - start, ...expected.map(() => eol))
      changed = true
    }
    index = start + expected.length
  }
  if (mode === '--write' && changed) rewrites.push([readme, lines.map((line, i) => line + endings[i]).join('')])
}

// A marker outside the READMEs scanned above would leave its block unchecked.
for (const path of trackedMarkdown().filter(path => !readmes.includes(path))) {
  // git lists the index, which still holds a file deleted from the working tree.
  if (!existsSync(join(repoRoot, path))) {
    console.warn(`note: skipped ${path}: git tracks it, but it is not in the working tree`)
    continue
  }
  readFileSync(join(repoRoot, path), 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (MARKER_START.test(line)) {
        problems.push(`${path}:${index + 1}: snippet markers are read only in the READMEs: ${readmes.join(', ')}`)
      }
    })
}

for (const snippet of EXPECTED.filter(snippet => !found.includes(snippet))) {
  problems.push(`${snippet}: the snippet marker is missing`)
}
for (const snippet of found.filter((snippet, i) => !EXPECTED.includes(snippet) || found.indexOf(snippet) !== i)) {
  problems.push(`${snippet}: the snippet is not listed in EXPECTED in examples/scripts/readme-snippets.mjs, or repeats`)
}

for (const problem of problems) console.error(problem)
if (mode === '--check' && drift.length > 0) {
  for (const difference of drift) console.error(difference)
  console.error('\nRun `node examples/scripts/readme-snippets.mjs --write` to update the README blocks.')
}
if (problems.length > 0 || (mode === '--check' && drift.length > 0)) process.exit(1)
for (const [readme, text] of rewrites) {
  writeFileSync(join(repoRoot, readme), text)
  console.log(`updated ${readme}`)
}
console.log(`readme snippets: ${found.length} ${mode === '--check' ? 'checked' : 'up to date'}`)

/**
 * The Markdown files git tracks in this tree, from `git ls-files` run at the
 * repository root. None, after a note, when git is missing, when the command
 * fails for any reason, or when its list does not include this script, so
 * that git does not track this tree. In CI, any of those reasons is recorded
 * as a problem instead: a scan skipped there would let a misplaced marker pass.
 */
function trackedMarkdown() {
  const skip = reason => {
    if (inCi) problems.push(`the scan of other Markdown files for snippet markers must run in CI, but: ${reason}`)
    else console.warn(`note: skipped the scan of other Markdown files for snippet markers: ${reason}`)
    return []
  }
  let listed
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--', '*.md', SCRIPT], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0')
  } catch (error) {
    if (error.code === 'ENOENT') return skip('git is not installed')
    const [message] = String(error.stderr || error.message)
      .trim()
      .split(/\r?\n/)
    return skip(`git ls-files failed: ${message}`)
  }
  if (!listed.includes(SCRIPT)) return skip(`git does not track this tree: git ls-files does not list ${SCRIPT}`)
  return listed.filter(path => path.endsWith('.md'))
}

/** The lines of region `name` in `source`, each part dedented and parts joined by a blank line. */
function readRegion(source, name) {
  const path = normalize(source)
  if (!path.startsWith(`examples${sep}`) || !existsSync(join(repoRoot, path))) {
    throw new Error(`${source} is not a file under examples/`)
  }
  const parts = []
  let part
  readFileSync(join(repoRoot, path), 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const region = REGION.exec(line)
      if (region === null) {
        part?.push(line)
      } else if (region[2] === name && region[1] === 'region') {
        if (part !== undefined) throw new Error(`${source}:${index + 1}: region ${name} opens again before it ends`)
        part = []
      } else if (region[2] === name) {
        if (part === undefined) throw new Error(`${source}:${index + 1}: region ${name} ends before it opens`)
        parts.push(dedent(part))
        part = undefined
      }
    })
  if (part !== undefined) throw new Error(`${source}: region ${name} never ends`)
  if (parts.length === 0) throw new Error(`${source} has no region ${name}`)
  return parts.flatMap((lines, i) => (i === 0 ? lines : ['', ...lines]))
}

/** `lines` without leading and trailing blank lines and without their common indentation. */
function dedent(lines) {
  const first = lines.findIndex(line => line.trim() !== '')
  if (first === -1) return []
  const last = lines.findLastIndex(line => line.trim() !== '')
  const kept = lines.slice(first, last + 1)
  const indent = Math.min(...kept.filter(line => line.trim() !== '').map(line => /^ */.exec(line)[0].length))
  return kept.map(line => line.slice(indent).trimEnd())
}
