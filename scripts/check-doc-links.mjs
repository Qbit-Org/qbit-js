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
// a relative docs link in any link form, so the site never gets one.
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
// A relative link to a docs page in any link form: a Markdown target
// (`](../docs/x.md)`, `](./../docs/x.md)`, `](docs/x.md)`), `{@link ../docs/x.md}`
// or an autolink `<docs/x.md>`. A path merely named in prose or in backticks is
// not a link and is left alone.
const RELATIVE_DOC_LINK =
  /\]\((?!https?:)[^)\s]*docs\/[^)\s]*\.md|\{@link\s+(?!https?:)[^}\s]*docs\/[^}\s]*\.md|<(?!https?:)[^>\s]*docs\/[^>\s]*\.md>/

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
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const where = `${relative(repoRoot, file)}:${index + 1}`
        if (RELATIVE_DOC_LINK.test(line)) {
          errors.push(`${where}: relative docs/ link; use the https://github.com/Qbit-Org/qbit-js/blob/main URL`)
        }
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
