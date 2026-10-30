# Releasing

How `@qbit-oss/protocol` and `@qbit-oss/api` are versioned, branched, tagged
and published. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Versioning

- [SemVer](https://semver.org). Both packages are versioned in **lockstep**:
  every release publishes both at the same version, from one release branch,
  with one CHANGELOG section. They ship as a pair from one branch and one
  commit, so one version names one tested combination. A package with
  no changes in a release still gets the new version.
- Before 1.0 the version is `0.MINOR.PATCH`:
  - **MINOR** (`0.1.x` → `0.2.0`) for any breaking change: a removed or renamed
    export, an incompatible type or signature, input that used to be accepted
    and is now rejected, an existing failure that now surfaces with a different
    error kind or code, or a changed retry or outcome contract, unless it is
    one of the behaviour changes below that a patch may carry.
  - **PATCH** (`0.1.0` → `0.1.1`) for backward-compatible fixes and additions.
  - **PATCH, as a behaviour change**, for a fix that changes behaviour only
    in one of these ways, and nothing else:
    - it refuses input that qbit Core refuses, or input with which the call
      could never have worked;
    - it refuses input that could make a call run without bound, even where
      some finite input of that shape is refused with it;
    - it adds a resource limit whose default holds every legitimate use the
      docs describe;
    - it reports an outcome as the reply actually shows it, where it was
      claimed more definitely or wrongly before: `unknown_outcome` where a
      definite error was claimed for a reply that could not be judged, or a
      resolved submission where the reply says the node already has the
      transaction;
    - it raises a dependency's minimum version within the same major;
    - it changes an error message without changing the error's kind, code or
      fields.

    Such a change can still make existing code fail or behave differently,
    so its CHANGELOG entry starts with **Behaviour change:**, and consumers
    on a caret range receive it with the next patch.
  - A caret range stays inside one line below 1.0 (`^0.1.0` means
    `>=0.1.0 <0.2.0`), so consumers never receive a **Breaking** change from
    a patch update, only the behaviour changes above.
- Release candidates are `X.Y.Z-rc.N`, with `N` starting at `0` (what
  `npm version preminor --preid rc` produces). They are published under the npm
  dist-tag `candidate`, never `latest`. The registry points `latest` at a new
  package's first version whatever its dist-tag, so a package's first publish
  is a final release, never a candidate: both packages start at `0.1.0`. Only
  final releases move `latest`.
- The workflow publishes a final release with no `--tag`, so npm applies
  `latest`. Before publishing, the npm client reads the package's versions
  from the registry and refuses (`Cannot implicitly apply the "latest" tag`)
  if a final release that is not deprecated is at or above the new version.
  A final release on an older line, such as `0.1.4` after `0.2.0`, therefore
  fails before anything is published, and needs a per-line dist-tag in the
  workflow first. The guard runs only in the npm client, not the registry:
  it ignores deprecated versions, so `0.1.4` takes `latest` if `0.2.0` is
  deprecated, and it is skipped if that registry lookup fails, so `latest`
  can then move backwards.
- `candidate` points at the most recently published candidate, so it can
  move backwards: `0.1.5-rc.0` published after `0.2.0-rc.1` takes `candidate`
  from it. If the newer line still has candidates out, a maintainer points
  the tag back from their npm account:
  `npm dist-tag add @qbit-oss/protocol@0.2.0-rc.1 candidate`, and the same for
  `@qbit-oss/api`.
- 1.0.0 is cut once the public API is declared stable. From then on breaking
  changes bump MAJOR.

## Branches

- `main` is the integration branch. Feature and fix PRs target `main`.
- `release/X.Y` stabilizes one minor line. It is cut from `main` when the line
  starts stabilizing and takes only fixes, docs, and version and CHANGELOG
  updates, each through a PR with a green `verify` check. Never merge `main`
  into a release branch.
- **Fixes flow back to `main`** through a back-merge PR from `release/X.Y` into
  `main`. Keep one draft back-merge PR open while the line has fixes `main`
  lacks, and merge it at least once per published version and before the next
  line is cut, so `main` never lacks a released fix. If it conflicts, resolve
  on a short-lived `backmerge/X.Y` branch cut from `release/X.Y` with `main`
  merged in, not on `release/X.Y` itself.
- A fix that lands on `main` first and is also needed on an active line is
  cherry-picked (`git cherry-pick -x`) onto `release/X.Y` in its own PR.
- `package.json` versions on `main` are never published. A back-merge may carry
  a release line's version onto `main`; that is expected.

## Versions on a release branch

Both `package.json` files on `release/X.Y` always hold the next version to be
published from that branch: `X.Y.0-rc.0` when the branch is cut. CHANGELOG
entries collect under that version's heading, marked `unreleased`, as their
PRs merge.

## Cutting a release candidate

1. Check that CI's `verify` check is green on the tip of `release/X.Y` and
   that the CHANGELOG section lists every change on the branch.
2. Create the annotated tag `vX.Y.Z-rc.N` on that commit and push it.
3. The [publish workflow](#publishing) publishes both packages at that version
   with `--tag candidate`, once another maintainer has
   [approved](#approving-a-publish) its `publish` job. Check that its run
   succeeded.
4. In a PR to `release/X.Y`, date the candidate's CHANGELOG section, open the
   next one, and bump both versions to `X.Y.Z-rc.N+1`.

## Final release

1. In a PR to `release/X.Y`, set both versions to `X.Y.Z` and turn the
   candidate sections into one dated `X.Y.Z` section.
2. Merge the back-merge PR into `main`. The READMEs and doc comments link to
   `blob/main`, so `main` must hold every page and example they link to
   before npm shows the new READMEs.
3. Create the annotated tag `vX.Y.Z` on the release commit and push it. The
   publish workflow publishes both packages under `latest`, once another
   maintainer has [approved](#approving-a-publish) its `publish` job. Then
   bump both versions to `X.Y.(Z+1)-rc.0` in a PR.

## Tags

Tags are `vX.Y.Z` and `vX.Y.Z-rc.N`, one per release for both packages. A tag
names no package. Tags are created only on release branches, by a maintainer,
and are never moved. Pushing one to `Qbit-Org/qbit-js` publishes that version.

## Publishing

Both packages were first published as 0.1.0 on 2026-10-26. Every publish
needs the one-time setup below to be in place.

`.github/workflows/publish.yml` publishes both packages when a `v*` tag is
pushed to `Qbit-Org/qbit-js`. Its jobs never run in any other repository,
such as a fork or a mirror. It has three jobs:

1. `build` holds no secret and no `id-token` permission. Besides pnpm,
   Node.js and the SHA-pinned actions, it runs only code that
   `pnpm-lock.yaml` pins: the locked dev dependencies and each package's
   `prepack`. It fails unless:
   - both packages have the same version, and the tag is `v` plus that
     version;
   - the version is `X.Y.Z` (published under the `latest` dist-tag) or
     `X.Y.Z-rc.N` (under `candidate`);
   - CHANGELOG.md has a `## <version>` section;
   - the tagged commit is on `release/X.Y`;
   - install, build, typecheck (sources and tests), tests and `pack:check`
     pass on that commit.

   It then packs both packages, records the two tarballs' SHA-256 sums in
   the same step, and uploads the tarballs as the run's `npm-tarballs`
   artifact. The sums and the artifact's ID are job outputs.
2. `smoke` runs after `build` and holds no secret or `id-token` either. It
   runs the checks `build` does not need in order to pack the tarballs:
   `consumer:check`, which type-checks and loads the packed packages offline
   with the lockfile's dependencies, and the checks that fetch code nothing
   pins: the fresh-consumer smoke, which installs whatever `@noble/hashes`
   1.8.x the registry serves, and `fixtures:check`, which clones qbit Core and
   runs the Python that `setup-python` installs. `consumer:check` and the
   smoke pack their own copies of the packages from the tagged commit.
3. `publish` runs once both pass, in the `npm` environment, so it starts
   only once a required reviewer [approves it](#approving-a-publish). It is
   the only job that can request the OIDC token for npm trusted publishing
   or read the `NPM_TOKEN` bootstrap secret, and it checks out nothing,
   installs nothing and runs no repository or dependency code. It downloads
   `build`'s artifact by its ID and fails unless:
   - the artifact holds exactly one tarball of the tagged version per
     package, and each matches the SHA-256 sum `build` recorded;
   - npm's own tarball reader, the one `npm publish` uses, reads each
     tarball's `package.json` as that package at the tagged version, and
     lists no path twice (`npm pack --dry-run` on the tarball);
   - as an extra layer, GNU tar lists every entry of each tarball under
     `package/`, with no empty, `.` or `..` path component, and exactly one
     `package/package.json`.

   It then runs `npm publish <tarball> --provenance --access public
   --ignore-scripts` for each, with `--tag candidate` for a release
   candidate. A final release gets no `--tag`, so npm applies `latest`,
   subject to [the npm client's guard](#versioning). A version already on
   npm is skipped if npm's `dist.integrity` for it is the tarball's, and
   fails the job otherwise, so re-running the failed `publish` job finishes
   a partial publish with the same tarballs. While `NPM_TOKEN` is set, the
   job fails if both packages already exist on npm, or if npm answers
   anything but `E404` (not found) when asked whether one does.

No job that runs third-party code can publish, and code that nothing pins
runs only in `smoke`, which can stop a release but cannot change the
tarballs `publish` checks. What remains is the build itself: a compromised
locked dev dependency, pnpm, Node.js or pinned action could still alter the
tarballs before `build` records their sums.

npm authenticates the `publish` job through trusted publishing (OIDC), so no
long-lived npm token is stored in GitHub, and every version carries a
provenance statement linking it to the workflow run and commit.

Publish only through this workflow. Both packages set
`publishConfig.provenance`, so `npm publish` from a workstation fails with
`Automatic provenance generation not supported`.

### Approving a publish

The run uses the workflow file of the tagged commit, so its own checks prove
nothing if that file was edited. The approver therefore checks, against their
own `git fetch origin --tags` rather than the run's log:

- [ ] the run is for the expected tag `vX.Y.Z` or `vX.Y.Z-rc.N`, and its
      commit (on the run page) is that tag's commit and is on `release/X.Y`:
      `git merge-base --is-ancestor <commit> origin/release/X.Y`;
- [ ] `.github/workflows/publish.yml` at that commit is the version reviewed
      on `release/X.Y`:
      `git diff origin/release/X.Y <commit> -- .github/workflows/publish.yml`
      prints nothing;
- [ ] every commit the release adds came through an approved PR to
      `release/X.Y`: review `git log <previous tag>..<commit>` and match each
      commit to its merged, approved PR. For a line's first release, review
      the branch's first-parent chain back to where it was cut from `main`:

      ```bash
      bp=$(git rev-list --first-parent <commit> | grep -m1 -Fxf <(git rev-list --first-parent origin/main))
      git log --first-parent $bp..<commit>
      ```

      Not `git merge-base origin/main <commit>`: after a back-merge into
      `main`, that is the release commit the back-merge brought in, which
      hides every commit before it;
- [ ] CHANGELOG.md at that commit has the `## <version>` section, listing the
      release's changes.

`publish` cannot start until `build` and `smoke` have passed.

If any item fails, reject the deployment; nothing is published.

### One-time setup

npm only lets a trusted publisher be configured for a package that already
exists. Each package's first version is therefore published with a
short-lived token, and trusted publishing takes over from the next release.

1. Make `Qbit-Org/qbit-js` public before the first publish. npm generates no
   provenance for a private repository, and `--provenance` then fails.
2. Create a team of the release maintainers, at least two people. A
   ruleset's bypass list takes roles, teams and apps, not individual users.
   Then add the rulesets (Settings → Rules → Rulesets). A bypass actor
   bypasses every rule of its ruleset, so creating refs and changing them are
   separate rulesets:
   - a tag ruleset on `v*` with Restrict creations, and the release
     maintainers team as its only bypass actor, so only they can push a tag
     that publishes;
   - a tag ruleset on `v*` with Restrict updates and Restrict deletions, and
     no bypass actors, so a tag is never moved or deleted;
   - a branch ruleset on `release/*` with Restrict creations, and the release
     maintainers team as its only bypass actor, so only they can cut a
     release branch;
   - a branch ruleset on `release/*` with Require a pull request before
     merging (at least one approval, Dismiss stale pull request approvals
     when new commits are pushed, and Require approval of the most recent
     reviewable push), Require status checks to pass (`verify`, from GitHub
     Actions), Block force pushes and Restrict deletions, and no bypass
     actors. The workflow's release-branch check means "reviewed" only while
     every change to `release/X.Y` comes through such a PR.
3. Create the environment `npm` (Settings → Environments):
   - Deployment branches and tags: Selected branches and tags, with the tag
     rule `v*`.
   - Required reviewers: the release maintainers team, with Prevent
     self-review checked, so whoever pushed the tag cannot approve its
     publish.
   - Allow administrators to bypass configured protection rules: unchecked.

   A pushed tag then publishes nothing until another maintainer approves.
4. First publish. On npmjs.com, create a granular access token with Read and
   write (publish and stage) access to the `@qbit-oss` scope only, Bypass
   two-factor authentication checked, and the shortest expiry that covers the
   release. Save it as the `NPM_TOKEN` secret of the `npm` environment, where
   only the approved `publish` job can read it, and push the first tag. With
   no trusted publisher configured, npm falls back to the token; the run
   still signs provenance. Then delete the secret and revoke the token. The
   workflow fails while `NPM_TOKEN` is set and both packages exist on npm.
   npm ends direct publishing with tokens in January 2027; after that, a new
   package's first version needs a stage-only token, `npm stage publish` and
   a maintainer's approval instead.
5. For each of `@qbit-oss/protocol` and `@qbit-oss/api`, open the package on
   npmjs.com, then Settings → Trusted publishing → GitHub Actions, and enter:
   - Organization or user: `Qbit-Org`
   - Repository: `qbit-js`
   - Workflow filename: `publish.yml`
   - Environment name: `npm`
   - Allowed actions: select npm publish. Configurations created since
     2026-09-03 allow only `npm stage publish` unless it is selected.

   With npm 11.15.0 or later and 2FA, the CLI does the same:
   `npm trust github @qbit-oss/protocol --repo Qbit-Org/qbit-js --file publish.yml --env npm --allow-publish`.
   A configuration expires unless a publish uses it within 2 days, so create
   it just before pushing the next tag, and recreate it if it expired.
6. Once a trusted publish has succeeded, set each package's Settings →
   Publishing access to "Require two-factor authentication and disallow
   tokens".
