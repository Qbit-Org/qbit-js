#!/usr/bin/env node
// Check the topic-page links in the packages' doc comments.
//
// Doc comments link to `docs/*.md` by absolute GitHub URL, which renders on
// GitHub, in IDE hovers and from the TypeDoc site (TypeDoc copies a relative
// `.md` target to the site unrendered, so its anchors do nothing there).
// TypeDoc does not check external URLs, so this does: every URL of this
// repository in packages/*/src must have the form
// https://github.com/Qbit-Org/qbit-js/blob/main/packages/<pkg>/docs/<page>.md
// and name a file in this repository, and its #anchor, if any, must be the
// GitHub slug of a heading in that page. Any other URL of this repository
// (`tree/`, another branch, a page outside packages/*/docs) fails, and so does
// a relative path into a docs directory anywhere in a doc comment outside code,
// so neither the site nor a hover ever gets one.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
// A URL ends at whitespace, a quote, a backtick, any bracket, `|` or `\`, so
// one inside `[...](...)`, `{@link ...}` or `<...>` is read alone, and
// sentence punctuation at its end is not part of it.
const URL_TOKEN = /[^\s'"`()[\]{}<>|\\]+/g
const TRAILING_PUNCTUATION = /[.,:;!?]+$/
const REPO_URL = /github\.com\/qbit-org\/qbit-js(?![\w-])/i
const DOC_URL =
  /^https:\/\/github\.com\/Qbit-Org\/qbit-js\/blob\/main\/packages\/(\w[\w.-]*)\/docs\/(\w[\w.-]*\.md)(?:#(.+))?$/
// A relative path into a docs directory: `docs/x.md`, `../docs/x.md#a`,
// `./docs/` or `../docs`, in any case, also in emphasis or before sentence
// punctuation. Neither TypeDoc nor an IDE hover resolves one against the
// repository, as a link target or as plain text, so a doc comment links a
// topic page by its URL instead. A bare `docs` or `docs#x` is a word or a
// declaration reference, not a path.
const RELATIVE_DOCS_PATH = /(?:^|[/=])docs\/|\/docs(?:[#?]|$)/i
// Emphasis around a token, and sentence punctuation after it.
const TOKEN_TRIM = /^[*_~]+|[*_~.,:;!?]+$/g
// A token with `//` after an optional URL scheme (`https:`, `ftp:`, any case)
// is absolute, and left to the URL checks.
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i
// A doc comment: a `/**` at the start of a line or after whitespace. One glued
// to other text, as in a glob string, is not.
const DOC_COMMENT = /(?:^|(?<=[ \t]))\/\*\*(?!\/)[\s\S]*?\*\//gm

// The offsets of the relative docs paths in a doc comment, outside code. Each
// line is read without its comment prefix (`/**` or `*`, and one space), as
// TypeDoc reads it. Fenced code blocks open and close as in headingSlugs below.
// A code span opens at a backtick run that is not escaped and closes at the
// next run of the same length, within its paragraph.
function relativeDocsPaths(comment) {
  let fence
  const prose = comment
    .split('\n')
    .map(line => {
      const prefix = /^(?:[ \t]*\/\*\*|[ \t]*\*(?!\/))?[ \t]?/.exec(line)[0]
      const content = line.slice(prefix.length)
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(content)
      let code = fence !== undefined
      if (!code && marker !== null) {
        fence = marker[1]
        code = true
      } else if (code && marker !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
        if (!marker[2].trim()) fence = undefined
      }
      return ' '.repeat(prefix.length) + (code ? ' '.repeat(content.length) : content)
    })
    .join('\n')
    .replace(/(?<![`\\])(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, span => span.replace(/[^\n]/g, ' '))
  return [...prose.matchAll(URL_TOKEN)]
    .filter(([token]) => {
      const path = token.replace(TOKEN_TRIM, '')
      return !ABSOLUTE.test(path) && RELATIVE_DOCS_PATH.test(path)
    })
    .map(token => token.index)
}

// Pin the rule, so an edit cannot loosen it unnoticed.
const MUST_FAIL = [
  '[x](../docs/x.md)',
  '![x](./../docs/images/a.svg)',
  '[x](../docs)',
  '[x](../docs/X.MD)',
  '[x](<../docs/a page.md>)',
  '[x](a((b))/docs/x.md)',
  '[x]: ../docs/x.md',
  '{@link ../docs/x.md}',
  '{@linkcode ../docs/x.md}',
  '{@linkplain ../docs}',
  '{@link\n * ../docs/x.md}',
  '<../docs/x.md#anchor>',
  '<a href="../docs/x.md">x</a>',
  '<img src=../docs/a.svg>',
  'see docs/x.md',
  'the docs/ directory',
  'see the pages in ../docs.',
  '**docs/x.md**, _docs/y.md_ and *docs/z.md*',
  'x=docs/a',
  'Note:../docs/x.md',
  'see \\`../docs/x.md\\`',
  'a stray ` backtick\n *\n * then ../docs/x.md and `code`',
  '    ```\n * ../docs/x.md',
]
const MUST_PASS = [
  '[x](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/x.md)',
  '<HTTPS://example.org/docs/a.md>',
  '[x](//example.org/docs/a.md)',
  '[x](ftp://host/docs/a.md)',
  '[x](my-docs/x.md) and [x](.docs/x.md)',
  '{@link docs} and {@link docs#member}',
  'the docs say so',
  'write `[x](../docs/x.md)` or ``<docs/x.md>``',
  '`a code span\n * across lines: ../docs/x.md`',
  '```md\n * [x](../docs/x.md)\n * ```',
  '~~~md\n * [x](../docs/x.md)\n * ~~~',
  '```ts\n * a\n * ```ts\n * ../docs/x.md\n * ```',
]
// And what counts as a doc comment.
const COMMENTS = [
  ['/** ../docs/x.md */', 1],
  ['  readonly x: number /** ../docs/x.md */', 1],
  ["const glob = 'src/**' // ../docs/x.md */", 0],
]
const selfTest = [
  ...MUST_FAIL.filter(sample => relativeDocsPaths(`/**\n * ${sample}\n */`).length === 0).map(s => `not caught: ${s}`),
  ...MUST_PASS.filter(sample => relativeDocsPaths(`/**\n * ${sample}\n */`).length > 0).map(s => `caught: ${s}`),
  ...COMMENTS.filter(([source, count]) => [...source.matchAll(DOC_COMMENT)].length !== count).map(
    ([source, count]) => `not ${count} doc comment(s): ${source}`
  ),
]
if (selfTest.length > 0) {
  for (const failure of selfTest) console.error(`check-doc-links self-test: ${failure}`)
  process.exit(1)
}

// GitHub's heading ids (github-slugger): lowercase, drop everything but
// letters, marks, numbers, connector punctuation, spaces and `-`, then turn
// each space into `-`. A repeated slug gets `-1`, `-2`, ... appended.
function headingSlugs(markdown) {
  const slugs = new Set()
  const seen = new Map()
  let fence
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence === undefined) {
      if (marker !== null) {
        fence = marker[1]
        continue
      }
    } else {
      // Only a bare run of the opening character, at least as long, closes it.
      if (marker !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined
      }
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    if (heading === null) continue
    const text = heading[1].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    slugs.add(count === 0 ? base : `${base}-${count}`)
  }
  return slugs
}

const pages = new Map()
function slugsFor(path) {
  if (!pages.has(path)) pages.set(path, headingSlugs(readFileSync(path, 'utf8')))
  return pages.get(path)
}

const errors = []
let checked = 0
for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
  const srcDir = join(repoRoot, 'packages', pkg, 'src')
  if (!existsSync(srcDir)) continue
  for (const entry of readdirSync(srcDir, { recursive: true })) {
    if (!entry.endsWith('.ts')) continue
    const file = join(srcDir, entry)
    const source = readFileSync(file, 'utf8')
    for (const comment of source.matchAll(DOC_COMMENT)) {
      for (const offset of relativeDocsPaths(comment[0])) {
        const line = source.slice(0, comment.index + offset).split('\n').length
        errors.push(
          `${relative(repoRoot, file)}:${line}: relative docs/ path; use an absolute https URL (a topic page here is https://github.com/Qbit-Org/qbit-js/blob/main/packages/<pkg>/docs/<page>.md)`
        )
      }
    }
    source.split('\n').forEach((line, index) => {
      const where = `${relative(repoRoot, file)}:${index + 1}`
      for (const [token] of line.matchAll(URL_TOKEN)) {
        if (!REPO_URL.test(token)) continue
        const url = token.replace(TRAILING_PUNCTUATION, '')
        const match = DOC_URL.exec(url)
        if (match === null) {
          errors.push(
            `${where}: ${url}: not a https://github.com/Qbit-Org/qbit-js/blob/main/packages/<pkg>/docs/<page>.md URL`
          )
          continue
        }
        checked++
        const [, urlPkg, page, anchor] = match
        const target = join(repoRoot, 'packages', urlPkg, 'docs', page)
        if (!existsSync(target)) {
          errors.push(`${where}: ${url}: ${relative(repoRoot, target)} does not exist`)
        } else if (anchor !== undefined && !slugsFor(target).has(anchor)) {
          errors.push(`${where}: ${url}: no heading in ${relative(repoRoot, target)} has the slug #${anchor}`)
        }
      }
    })
  }
}

for (const error of errors) console.error(error)
if (errors.length > 0) process.exit(1)
console.log(`doc links: ${checked} checked, PASS`)
