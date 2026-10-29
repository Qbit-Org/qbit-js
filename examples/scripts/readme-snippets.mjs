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
// fails both modes too, since its block would never be checked; listing those
// files needs git.
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
/** Markers that cannot be resolved. */
const problems = []
for (const readme of readmes) {
  const original = readFileSync(join(repoRoot, readme), 'utf8')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(eol)
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
    }
    index = start + expected.length
  }
  const updated = lines.join(eol)
  if (mode === '--write' && updated !== original) {
    writeFileSync(join(repoRoot, readme), updated)
    console.log(`updated ${readme}`)
  }
}

// A marker outside the READMEs scanned above would leave its block unchecked.
const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: repoRoot, encoding: 'utf8' })
for (const path of tracked.split('\0').filter(path => path !== '' && !readmes.includes(path))) {
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
console.log(`readme snippets: ${found.length} ${mode === '--check' ? 'checked' : 'up to date'}`)

/** The lines of region `name` in `source`, each part dedented and parts joined by a blank line. */
function readRegion(source, name) {
  const path = normalize(source)
  if (!path.startsWith(`examples${sep}`) || !existsSync(join(repoRoot, path))) {
    throw new Error(`${source} is not a file under examples/`)
  }
  const parts = []
  let part
  readFileSync(join(repoRoot, path), 'utf8')
    .split('\n')
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
