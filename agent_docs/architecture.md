# Architecture notes (`electron/`, `renderer/`, `workers/`)

> Read before editing `electron/`, `renderer/`, or `workers/`, or when debugging
> worker spawn, IPC, or startup crashes. Only non-obvious, code-verified facts —
> the code is the reference for everything else. Index: [AGENTS.md](../AGENTS.md).

Renderer (sandboxed) ↔ `window.bridge` (Electron IPC) ↔ main (broker only) ↔ fd-3
FramedStream pipe ↔ Bare worker (`workers/main.js`: swarm + corestore + updater +
`backend/`). The JSON IPC protocol is documented at the top of `workers/main.js`.
The code is small — read it for the wiring; below are only the non-obvious facts.

- The paparam parse at the top of `electron/main.js` throws on **any** unknown flag
  or positional → packaged app crashes at startup. The app registers no URL scheme.
- The worker specifier `'/workers/main.js'` is the worker's **identity** — embedded
  in every IPC channel name; must start with `/`. `pear:startWorker` rejects any
  other specifier.
- Six-arg spawn order (`getWorker()` → worker argv): `updates`, `version`,
  `upgrade`, bundle name (`productName`+ext), storage dir, installed app path.
  Wrong-but-parseable orders fail silently. (Worker reads at offset +2 on
  desktop, 0 on mobile/BareKit.)
- The worker resolves modules against this `package.json`, so Node builtins it
  uses need an `imports` entry. A missing entry only fails in a packaged build.
- Pipe protocol = plain UTF-8 strings in FramedStream frames, matched by exact
  equality. Unknown →worker strings get `console.log`ged; unknown worker→ strings
  are forwarded to the renderer.
- `pear:applyUpdate` is hardwired to `'/workers/main.js'` and lazily respawns a
  dead worker. It rejects when the worker replies `pear:updateFailed:<message>`,
  but has no timeout: a worker that never replies still hangs the renderer.
- `sendToAll` broadcasts every worker channel to **all** windows; nothing restarts
  a crashed worker.
- Per-platform storage dir is chosen in `getStorageDir()` (dev:
  `<tmpdir>/pear/Changefeed`). Inside: `pear-runtime/corestore`,
  `pear-runtime/next/<length>.<fork>/` (wiped on every updates-enabled launch),
  `app-storage/` (suggested `pear.storage` for app data).
- **A stall is usually the network, not the code, and the two look identical.** An
  update that never arrives, or a peer that never connects, most often means this
  machine is unreachable: `pear seed <link> --json` prints `firewalled` and
  `natType`, and `natType: "Random"` is symmetric NAT, which defeats holepunching
  (`upload.totalBytes` then stays 0 however long it runs). Before debugging app
  logic, connect two bare Hyperswarm instances on a random topic with no app code —
  if that fails, nothing above it can work. Exercise real replication against a
  local `hyperdht/testnet` rather than the public DHT.
