# Releasing Changefeed

Every command used to build, stage and release the app, with what it did.
Kept up to date as the release process is exercised.

Environment: macOS (darwin-arm64), Node v23.11.0, npm 11.3.0, Pear CLI 3.6.0.

---

## Phase 1 — setup and smoke test (unchanged template)

### Install the Pear CLI

```sh
curl https://install.pears.com/pear.sh | sh
```

Downloads a single checksum-verified binary to `~/.local/bin/pear` and appends
`~/.local/bin` to `PATH` in `~/.zshrc`. (`npx pear` also works without installing.)
`pear` has no `--version` flag; the version is shown in the help banner
(`pear://smw4…igy - 3.6.0`).

### Template

```sh
git clone https://github.com/holepunchto/hello-pear-electron
npm install
```

Installed cleanly (899 packages; npm audit warnings come from Electron Forge
tooling, not the runtime).

### Create the app link

```sh
pear touch
```

Result: `pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy`, written to
`package.json#upgrade`.

- The link is public and safe to commit. The **write key** for it lives in
  the local Pear sidecar storage (not in this repo). Losing that machine's
  Pear storage means losing the ability to release to this link.
- This is the **stage link**. Pear has three release lines (stage → provision
  → multisig), and the link in `upgrade` decides which line a build follows.
  We ship on the stage link: multisig needs at least 3 separate machines
  seeding (`SOURCE_CORE_INSUFFICIENT_PEERS` otherwise), which is out of scope
  for a solo project.

### Run in dev

```sh
npm start            # = electron-forge start -- --no-updates
```

Window opened; the Bare worker started as
`bare workers/main.js false 1.0.0 pear://7ffu… HelloPear.app <tmpdir>/pear/HelloPear null`
(the six spawn args: updates, version, upgrade link, bundle name, storage dir, app path).

### Package, build, dry-run stage

```sh
npm run package      # → out/HelloPear-darwin-arm64/HelloPear.app

# pear build must run OUTSIDE the app folder, otherwise the deployment
# folder gets staged into itself and grows on every release.
mkdir -p ../p2p-app-tether-builds && cd ../p2p-app-tether-builds
pear build --package=../p2p-app-tether/package.json \
  --darwin-arm64-app ../p2p-app-tether/out/HelloPear-darwin-arm64/HelloPear.app \
  --target hellopear-1.0.0

pear stage --dry-run pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy ./hellopear-1.0.0
```

`pear build` produced `hellopear-1.0.0/{package.json, by-arch/darwin-arm64/app/HelloPear.app}`.
The dry-run stage listed the full diff and ended with `Staging dry run complete!`
Nothing was persisted.

`npm run package` is enough for staging; `npm run make` (installers/DMG) is only
needed for handing out a first install file.
