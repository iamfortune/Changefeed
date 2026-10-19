# Changefeed

**Peer-to-peer release notes.** A maintainer publishes release notes straight
from their machine; subscribers follow the feed by key, receive new notes live,
and keep every note on disk, so the feed still works offline. No server, no
accounts, no mailing list.

Built on [Pear](https://docs.pears.com) from the
[hello-pear-electron](https://github.com/holepunchto/hello-pear-electron)
template: Hyperswarm, Hyperbee and Corestore, running in Bare, with
over-the-air updates delivered peer to peer.

![Subscriber view](assets/screenshot-subscriber.png)

## Try it in 2 minutes

macOS on Apple silicon:

```sh
# 1. Install the Pear CLI, then open a new terminal so `pear` is on your PATH
curl https://install.pears.com/pear.sh | sh

# 2. Install Changefeed from its pear:// link
pear install pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy
```

3. Open **Changefeed** from `~/Applications`, go to **Subscribe** and paste
   this demo feed key:

   ```
   truftdtxp1mbq7mpkgrsputayfhsytsfjacsmuknpyozasug7pzo
   ```

   The notes sync down and stay readable offline. Then try **Publish** to
   start your own feed.

Or follow the same feed from the terminal (macOS or Linux, with Node):

```sh
git clone https://github.com/iamfortune/Changefeed && cd Changefeed
npm install
npm run cli -- subscribe truftdtxp1mbq7mpkgrsputayfhsytsfjacsmuknpyozasug7pzo
```

The app link and the demo feed are kept online around the clock by an
always-on peer: a small server running `pear seed` and the Changefeed CLI.
It is just another peer, holding copies; nothing in the app depends on it.

## The problem

Release notes usually live on a website, a mailing list or a GitHub releases
page. All of them are someone else's server: it can go down, rate-limit you,
change its terms, or simply be unreachable when you're offline.

Changefeed takes the server out. The maintainer's machine is the source of
truth, and every subscriber keeps a full, verifiable copy of the feed. Paste a
feed key once and you have every note, forever, online or not. Any subscriber
who is online also helps serve the feed to others.

The app itself is distributed the same way: it installs from a `pear://` link
and updates over the air from peers.

## Install

```sh
# Pear CLI (one-off): https://docs.pears.com
curl https://install.pears.com/pear.sh | sh

pear install pear://7ffucmhbpa7z5hcao4t6435c6ndqryn38iu6nfzqwubqykap15yy
```

This installs `Changefeed.app` to `~/Applications`. Releases are currently
built for **macOS on Apple silicon** only.

> **There is no download server.** The app is fetched from peers that hold
> it. An always-on peer seeds the link (see [Try it](#try-it-in-2-minutes)).
> If the install hangs on "looking for peers", no seeder is reachable.

## How to use it

### Maintainer: publish a feed

1. Open **Publish** and give your feed a name (e.g. "Changefeed releases").
2. Copy the **feed key** and share it however you like: README, website, chat.
3. Write a note: version, title, body. The version field suggests the next
   patch number. Press **Publish** (or Cmd/Ctrl+Enter).

![Publisher view](assets/screenshot-publisher.png)

Each device has one feed, and only that device can write to it.

### Subscriber: follow a feed

1. Open **Subscribe** and paste a feed key.
2. Every existing note syncs down, then new ones appear live. The status line
   shows "Connected to N peers", or "Offline: showing saved notes" when no one
   is around.

Follow as many feeds as you like; unread counts show on the tab and per feed.

### CLI: follow a feed from the terminal

```sh
npm install
npm run cli -- subscribe <feed-key>
```

```
changefeed-cli v1.0.1  storage: ~/Library/Application Support/changefeed-cli
Waiting for feed…  ctmism4sbnoofeqfczqq7cwcacs6ugmo5ff67e1qpzr4bbgcw54o

No saved notes yet; looking for peers…

Listening for new notes. Ctrl+C to stop.

[1 peer connected]

Feed: Changefeed releases

1.0.0  First release  2026-10-18 00:30
  line one
  line two

1.0.1  Second  2026-10-18 00:30

● new 1.0.2  Live one  2026-10-18 00:31
```

Prints saved notes oldest first, then streams new ones (marked `● new`). It
keeps its own storage (`--storage <dir>` to change it), so it can run next to
the desktop app, and it works offline.

### Run from source

```sh
npm install
npm start                                  # instance 1
npm start -- --storage /tmp/changefeed-b   # instance 2, separate storage
```

Create a feed in one, subscribe from the other. `npm start` runs with OTA
updates off.

## Architecture

```
Desktop app
┌──────────────────────── Electron ────────────────────────┐
│  renderer/  ⇄  preload (window.bridge)  ⇄  electron/main │
└────────────────────────────┬─────────────────────────────┘
                             │ IPC pipe (bytes, JSON messages)
┌──────────────────── Bare worker ─────────────────────────┐
│  workers/main.js                                         │
│    ├─ backend/        feeds, notes, discovery            │
│    └─ pear-runtime    OTA updates                        │
│  one Corestore + one Hyperswarm, shared by both          │
└────────────────────────────┬─────────────────────────────┘
                             │
                     peers on the Hyperswarm DHT
                             │
┌──────────────────── Bare (terminal) ─────────────────────┐
│  cli/bin.mjs                                             │
│    └─ backend/        the same code, unchanged           │
│  its own Corestore + Hyperswarm                          │
└──────────────────────────────────────────────────────────┘
```

- **renderer/**: the UI. Talks JSON to the worker through the template's
  preload bridge and never touches P2P code.
- **electron/**: window management and a byte relay. Electron main doesn't
  parse app messages; it pipes them to and from the worker.
- **workers/main.js**: the desktop host, running in a Bare process
  (pear-runtime). It creates one Corestore and one Hyperswarm, shares them
  between the OTA updater and `backend/`, and translates IPC requests into
  backend calls. The JSON protocol is documented at the top of the file.
- **backend/**: the P2P logic. More below.
- **cli/**: the terminal host for the same backend.

### Data model

A feed is a [Hyperbee](https://github.com/holepunchto/hyperbee), a sorted
key/value store on a single-writer
[Hypercore](https://github.com/holepunchto/hypercore). The feed key is the
core's public key, so every note a subscriber receives is signed by the
maintainer and verified on arrival.

| Key                           | Value                                 |
| ----------------------------- | ------------------------------------- |
| `info`                        | `{ name }`                            |
| `note!<ms timestamp, padded>` | `{ version, title, body, createdAt }` |

Hyperbee sorts keys byte by byte, so zero-padding the timestamp makes key
order equal time order: "newest first" is a reverse range read. A separate
local-only Hyperbee remembers which feed is yours and which you follow.

### Networking

- Each feed joins Hyperswarm on its core's **discovery key** (a hash of the
  public key), so peers find each other without revealing the key itself.
- The host replicates its whole Corestore on every connection. That one stream
  carries the feeds _and_ the app's own update drive.
- Subscribers download the whole feed eagerly, so it's on disk before they go
  offline. Live notes come from watching the Hyperbee and diffing versions.

## Why `backend/` is shareable

The brief gives extra points for backend code that can be shared between
desktop, mobile and CLI. `backend/` is written for that:

- **No host assumptions.** No Electron, no UI, no `process`/`argv`/env. Node
  built-ins map to `bare-*` modules through the `imports` field in
  `package.json`, so it runs under Bare.
- **The host owns the resources.** It passes in a Corestore (storage) and a
  Hyperswarm (networking) and wires replication once. The backend only
  decides which topics to join, so it can share a swarm with the updater
  without opening a second replication stream.
- **Plain events out.** `note`, `feed` and `peers` events plus promise-based
  methods (`createFeed`, `publish`, `subscribe`, `notes`). A host forwards
  them over IPC (desktop) or prints them (CLI).

**Today it has two hosts, and `backend/` hasn't changed since it was first
written:**

```sh
git log --oneline -- backend/   # one commit, from before the worker or CLI existed
```

| Host          | How it runs `backend/`                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| Desktop       | `workers/main.js` in a Bare worker, behind JSON IPC, next to the OTA updater |
| CLI           | `cli/bin.mjs` hosts it directly in one Bare thread                           |
| Mobile (next) | the same worker under [pear-mobile](https://docs.pears.com) on BareKit       |

The worker already reads its arguments the BareKit way when it runs on mobile
(`which-runtime`), following the template. A mobile build hasn't been made or
tested yet.

## Releases and OTA updates

Releases go out with the Pear CLI to the app's `pear://` link, which is in
`package.json#upgrade`. The short version:

```sh
npm version patch && npm run package
pear build --package=… --darwin-arm64-app out/…/Changefeed.app --target changefeed-X.Y.Z
pear stage pear://7ffu…5yy ./changefeed-X.Y.Z
pear seed  pear://7ffu…5yy
```

Every running install watches the link through
[pear-runtime](https://docs.pears.com) and its updater. When a new version is
staged:

1. The app fetches only the changed blocks from peers. The v1.0.0 → v1.0.1
   diff was 9 files, a few kB, and landed in about 4 seconds.
2. The worker sends `updated` and the app shows **Update ready**.
3. **Restart to update** swaps the new build in place and relaunches.

The updater runs with `delay: 0` so updates show up immediately for the demo.
The production default waits a random time of up to an hour (after a 60 s boot
grace period) so a release doesn't hit every install at once.

[RELEASING.md](RELEASING.md) has every command that was actually run, the
v1.0.0 and v1.0.1 verlinks, and the gotchas found on the way.

## Test

```sh
npm test
```

All three suites run on the exact Bare binary the app embeds:

1. **Backend**: two peers over the real DHT. Existing notes sync, a live note
   arrives, and the subscriber restarts offline and still has all of them.
2. **Worker IPC**: two real worker processes driven through the JSON protocol.
3. **CLI**: the real CLI against a live feed. Existing notes, a live note,
   Ctrl+C, and an offline restart.

## Known limitations

- **Needs a seeder for installs and updates.** Apps don't seed the app itself;
  `pear seed` has to be running somewhere. For now that's one small server
  (plus the author's laptop): if both are down, the link can't be installed.
  More seeders, ideally run by different people, would remove that single
  point. Feeds work the same way: a subscriber needs the maintainer or another
  subscriber online to get new notes.
- **Stage link instead of multisig.** Production Pear apps release through
  stage → provision → multisig, which needs at least three machines seeding.
  This app ships on the stage link, so one key can push updates.
- **The first update after `pear install` re-downloads the whole app**
  (about 367 MB). `pear install` fetches into the Pear CLI's storage and the
  installed app starts with an empty Corestore. Later updates only fetch the
  diff.
- **One writer per feed, one feed per device.** Losing the device's storage
  means losing the ability to publish to that feed.
- **macOS arm64 builds only**, so far.
- **The CLI isn't released on its own `pear://` link.** Run it from the repo.

## Next steps

- **Multi-writer feeds** with Autobase, so a team can share one feed from
  several machines.
- **Signed release notes.** Hypercore already signs every entry with the feed
  key. A next step is linking notes to the software's own signing key, so a
  note can prove it describes a specific release.
- **Mobile** through pear-mobile, reusing `backend/` and the worker.
- **More seeders** and multisig releases.
- Builds for Linux, Windows and Intel Macs.

## Layout

| Path           | What                                                             |
| -------------- | ---------------------------------------------------------------- |
| `backend/`     | Shareable P2P core: feeds, notes, discovery. No Electron, no UI. |
| `workers/`     | Desktop host: runs `backend/` + the OTA updater in Bare.         |
| `electron/`    | Window + byte relay between renderer and worker.                 |
| `renderer/`    | UI (plain HTML/CSS/JS).                                          |
| `cli/`         | Terminal subscriber: a second host for `backend/`.               |
| `scripts/`     | Runs scripts on the Bare binary the app embeds.                  |
| `test/`        | Backend, worker and CLI tests.                                   |
| `RELEASING.md` | How releases are built, staged and shipped.                      |

## Credits

Started from Holepunch's
[hello-pear-electron](https://github.com/holepunchto/hello-pear-electron)
template.
