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

Second gotcha, found in phase 4: the sidecar Bare is not a plain `bare`. Its
bootstrap (`bare-sidecar/lib/runtime.js`) opens fd 3 as `Bare.IPC` and calls
`Bare.exit()` when that pipe closes, unless the script has its own `close`
listener on it. Started without an fd 3, a script is cut off mid-run with
exit code 0, which looked like a passing test. The runner now passes an open
fd 3 and test scripts call `Bare.exit(0)` when done.

Check before every release:

```sh
npm test                                  # backend on app Bare + worker IPC
npm run package                           # then launch the packaged app:
open -n out/Changefeed-darwin-arm64/Changefeed.app --args --storage /tmp/cf-check
```

## Phase 6 — real releases and an OTA update

Updater `delay: 0` is set in `workers/main.js` for the demo, so an installed
app fetches a release as soon as it sees it. Without it, pear-runtime-updater
waits a random delay of up to 1 hour (after a 60 s boot grace period) to spread
load across peers. Remove it for a real rollout.

### Release loop (what was actually run)

```sh
# 1. version + build the app
npm version patch                 # bumps package.json, commits, tags vX.Y.Z
npm run package                   # → out/Changefeed-darwin-arm64/Changefeed.app

# 2. deployment folder, outside the repo
cd ../p2p-app-tether-builds
pear build --package=../p2p-app-tether/package.json \
  --darwin-arm64-app ../p2p-app-tether/out/Changefeed-darwin-arm64/Changefeed.app \
  --target changefeed-X.Y.Z

# 3. stage to the app link (dry run first, read the diff)
pear stage --dry-run pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy ./changefeed-X.Y.Z
pear stage           pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy ./changefeed-X.Y.Z

# 4. keep it available: apps never seed, a seeder must be online
pear seed pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy
```

`pear provision` is skipped: `package.json#upgrade` is the stage link, so
installs follow the stage line directly. Provision → multisig is the
production path (see Phase 1 for why multisig is out of scope).

### Install from the link

```sh
pear install pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy
```

Installs to `~/Applications/Changefeed.app` (`--to <dir>` overrides).
A seeder must be online at the time.

### Results

| Release | Verlink                  | Notes                                                              |
| ------- | ------------------------ | ------------------------------------------------------------------ |
| v1.0.0  | `pear://0.1527.7ffu…5yy` | Installed from the link: 366 MB from 1 peer (the seeder)           |
| v1.0.1  | `pear://0.1536.7ffu…5yy` | Diff: 9 files, a few kB. Running install had it in `next/` in ~4 s |
| v1.0.2  | `pear://0.1585.7ffu…5yy` | Note counts. Running install had it in `next/` in ~1 s; applied    |

What we saw:

- The installed app's worker started as
  `workers/main.js true 1.0.0 pear://7ffu… Changefeed.app ~/Library/Application Support/Changefeed ~/Applications/Changefeed.app`
  (updates on, real app path).
- Within ~4 s of `pear stage`, the running app created
  `~/Library/Application Support/Changefeed/pear-runtime/next/1536.0/` holding a
  complete Changefeed.app whose Info.plist says `1.0.1`.
- **The first update after `pear install` downloads the whole app again**
  (seeder upload: 367 MB for the install, +367 MB for v1.0.1). `pear install`
  fetches through the Pear CLI's own storage; the installed app keeps its own
  Corestore, which starts empty. Updates after that only fetch changed blocks.

- The app showed "Update ready", and **Restart to update** swapped the build
  in place: afterwards `~/Applications/Changefeed.app` reports `1.0.1`
  (Info.plist and `Resources/app/package.json`), the relaunched worker runs
  with version `1.0.1`, and `pear-runtime/next/` has been cleaned up.

### Order matters for seeding

An app looks for seeders at startup and then roughly every 15 minutes. Start
`pear seed` **before** opening the installed app, or the app may not see the
release until its next lookup. The seeder here reports `firewalled: true`,
`NAT type consistent`: holepunching works, but for others to install while
this laptop is closed, the link needs an always-on seeder (e.g. a small VPS
running `pear seed`).

### v1.0.2 notes

- **Packaging leaked local files.** Electron Packager copies the whole project
  folder and does not read `.gitignore`, so local-only files ended up inside
  v1.0.0 and v1.0.1. `forge.config.js` now sets `packagerConfig.ignore`
  (which replaces Forge's default `/out/` rule, so that is listed again).
  Check `out/Changefeed-darwin-arm64/Changefeed.app/Contents/Resources/app/`
  before every `pear build`. Older versions on the link still contain them:
  a Hyperdrive is append-only.
- **"Update ready" is sent once.** On macOS, closing the window leaves the app
  running. The update downloaded while no window was open, so the message went
  nowhere and no banner appeared. Quitting and reopening the app showed it.
