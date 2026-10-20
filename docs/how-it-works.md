# How Changefeed works

## Architecture

```
Desktop app
┌──────────────────────── Electron ────────────────────────┐
│  renderer/  ⇄  preload (window.bridge)  ⇄  electron/main │
└────────────────────────────┬─────────────────────────────┘
                             │ pipe (JSON messages)
┌──────────────────── Bare worker ─────────────────────────┐
│  workers/main.js                                         │
│    ├─ backend/        feeds, notes, syncing              │
│    └─ pear-runtime    app updates                        │
│  one Corestore and one Hyperswarm, shared by both        │
└────────────────────────────┬─────────────────────────────┘
                             │
                     other peers on the network
                             │
┌──────────────────── Bare (terminal) ─────────────────────┐
│  cli/bin.mjs                                             │
│    └─ backend/        the same code                      │
└──────────────────────────────────────────────────────────┘
```

- **renderer/** is the UI. It sends JSON requests to the worker through the
  preload bridge and never runs P2P code itself.
- **electron/** opens the window and passes messages between the UI and the
  worker without reading them.
- **workers/main.js** runs in Bare. It creates the storage (Corestore) and
  network connection (Hyperswarm), shares them between the app updater and
  `backend/`, and turns UI requests into backend calls. The message format is
  described at the top of the file.
- **backend/** holds all the feed logic. It has no Electron or UI code, so the
  desktop worker and the CLI both run it unchanged.
- **cli/** runs `backend/` directly in the terminal.

## Data format

A feed is a [Hyperbee](https://github.com/holepunchto/hyperbee), a sorted
key-value store on a [Hypercore](https://github.com/holepunchto/hypercore).
Only the maintainer's device can write to it. The feed key is the Hypercore's
public key, so every note is signed by the maintainer and checked when it
arrives.

| Key                     | Value                                 |
| ----------------------- | ------------------------------------- |
| `info`                  | `{ name }`                            |
| `note!<padded ms time>` | `{ version, title, body, createdAt }` |

Keys sort as bytes, so the zero-padded timestamp keeps notes in time order.
"Newest first" is a reverse range read.

A second, local-only Hyperbee records which feed the device owns and which
feeds it follows, so they reopen after a restart without the network.

## Syncing

- Each feed joins Hyperswarm on its discovery key, a hash of the feed key, so
  peers find each other without broadcasting the key.
- The host replicates its whole Corestore over each connection. One stream
  carries both the feeds and app updates.
- Subscribers download the whole feed as soon as they can, so it is on disk
  before they go offline. Every peer also serves the feeds it holds, so
  subscribers can sync from each other while the maintainer is offline.
- New notes are found by watching the Hyperbee and comparing versions.

## App updates

The app installs and updates from its `pear://` link, set in
`package.json#upgrade`. Each install watches that link with `pear-runtime`.
When a new version is staged:

1. The app downloads only the changed files from peers.
2. The UI shows **Update ready**.
3. **Restart to update** swaps in the new build and relaunches.

The updater uses `delay: 0`, so it checks right away. Without it, installs
wait a random delay of up to an hour so a release doesn't reach everyone at
once.

## Releasing

```sh
# 1. bump the version and build the app
npm version patch
npm run package    # → out/Changefeed-darwin-arm64/Changefeed.app

# 2. build the release in a folder outside the repo
mkdir -p ../p2p-app-tether-builds && cd ../p2p-app-tether-builds
pear build --package=../p2p-app-tether/package.json \
  --darwin-arm64-app ../p2p-app-tether/out/Changefeed-darwin-arm64/Changefeed.app \
  --target changefeed-X.Y.Z

# 3. stage it (check the dry run first)
pear stage --dry-run pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy ./changefeed-X.Y.Z
pear stage pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy ./changefeed-X.Y.Z

# 4. keep it available
pear seed pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy
```

The `pear build` folder must be outside the project, or each release copies
the previous one into itself. There is no
downgrade: to roll back, stage the old code under a higher version number.
`pear seed` must run on a machine other peers can reach, or nobody receives
the release.

An always-on server runs `pear seed` and the CLI subscribed to the demo feed,
so the app link and demo feed stay available. It is an ordinary peer; the
app does not depend on it.

## Tests

`npm test` runs three suites:

1. **test/two-peers.js**: two backends on the real network, on the Bare
   binary the app ships with. Existing notes sync, a live note arrives, and the
   subscriber restarts offline with every note.
2. **test/worker-ipc.js**: two worker processes driven through the JSON
   messages, without a window.
3. **test/cli.js**: the CLI against a live feed: existing notes, a live note,
   Ctrl+C, and an offline restart.

## Limitations

- **Someone has to be online.** Installs and updates need a peer running
  `pear seed`. New notes need the maintainer or another subscriber online.
- **First update downloads the whole app** (about 367 MB), because
  `pear install` saves the app somewhere the installed app can't reuse. Later
  updates only download changes.
- **One feed per device, one device per feed.** If the device's storage is
  lost, nobody can publish to that feed again.
- **macOS on Apple silicon only** for now.
- **The CLI has no `pear://` link.** Run it from the repo.
- **Releases use the stage link**, so one key can push updates. Pear's
  multisig release flow needs at least three machines seeding.

## Next steps

- Feeds that several devices can publish to, using Autobase.
- A mobile app that reuses `backend/` and the worker.
- More seeding peers, run by different people.
- Builds for Linux, Windows and Intel Macs.
