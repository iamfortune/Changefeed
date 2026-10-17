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

## Phase 3 — rename and worker

The app was renamed from `HelloPear` to **Changefeed** before the first real
release (`package.json` name/productName, `forge.config.js`,
`build/AppxManifest.xml`, `flatpak/`). From now on:

```sh
npm run package      # → out/Changefeed-darwin-arm64/Changefeed.app
pear build --package=../p2p-app-tether/package.json \
  --darwin-arm64-app ../p2p-app-tether/out/Changefeed-darwin-arm64/Changefeed.app \
  --target changefeed-<version>
```

`pear.json` was **not** changed: any edit to it changes the multisig
production key, and we don't release through multisig.

### Bare version gotcha

The worker runs on the Bare binary embedded by `bare-sidecar` (a dependency
of `pear-runtime`), not on any Bare you install yourself. Packages can declare
a minimum Bare version (`engines.bare`); if one is newer than the embedded
runtime, the worker dies at boot with `UNSUPPORTED_ENGINE`.

Hit this after adding dependencies: `bare-type@1.4.0` needs Bare ≥ 1.32,
the lockfile had `bare-sidecar@0.5.2` (Bare 1.29.4). Fixed with
`npm update bare-sidecar` → 0.5.8 (Bare 1.34.1), within pear-runtime's
`^0.5.2` range. `npm test` now runs the backend test on that same embedded
binary (`test/run-on-app-bare.js`) so this can't hide again.

Check before every release:

```sh
npm test                                  # backend on app Bare + worker IPC
npm run package                           # then launch the packaged app:
open -n out/Changefeed-darwin-arm64/Changefeed.app --args --storage /tmp/cf-check
```
