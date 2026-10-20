# AGENTS.md

Changefeed: peer-to-peer release notes. Electron desktop app plus a terminal
CLI, both running the same `backend/` on Bare. App updates come from peers
through `pear-runtime`. See [docs/how-it-works.md](docs/how-it-works.md) for
the architecture.

The updater does not run in Electron. `electron/main.js` only starts a Bare
worker (`workers/main.js`) and passes bytes to and from it.

## Commands

Use npm, not pnpm (pnpm breaks `forge.config.js`).

```sh
npm start                         # dev app, updates off
npm start -- --storage <dir>      # second instance with its own storage
npm test                          # backend on the app's Bare, worker IPC, CLI
npm run lint                      # prettier --check . && lunte (same as CI)
npm run format                    # prettier --write . && lunte --fix
npm run cli -- subscribe <key>    # terminal subscriber
npm run package                   # → out/Changefeed-<platform>-<arch>/
```

Work is done when `npm run lint` and `npm test` pass. For changes under
`workers/` or `backend/`, also check the packaged app starts
(`npm run package`): modules resolve differently there than in dev.

## Things that must change together

- Worker argument order: `getWorker()` in `electron/main.js` ↔ `argv()` reads in
  `workers/main.js` ↔ `startWorker()` in `test/helpers.js`.
- Worker path `'/workers/main.js'`: `electron/main.js` ↔
  `renderer/worker-client.js`. Main refuses to start any other worker.
- Message format: comment at the top of `workers/main.js` ↔
  `renderer/worker-client.js` ↔ `electron/main.js` (updater strings).
- Node built-ins used by `backend/` or `workers/` need an entry in
  `package.json#imports` (e.g. `events` → `bare-events`). A missing entry works
  in dev and fails only in the packaged app.
- Feed storage namespace `'changefeed'`: `workers/main.js` ↔ `cli/bin.mjs`.

## Rules

- Commits and pull requests are authored by the maintainer only. Never add
  `Co-Authored-By` lines, "Generated with" lines or any AI attribution.
- Ask first before: new dependencies, Electron upgrades, changing
  `package.json#upgrade`, or `build/AppxManifest.xml` identity.
- Never run `pear stage`, `pear seed`, `pear provision` or `pear multisig`, or
  push `v*` tags, unless the user asked for exactly that.
- Never enable asar: it breaks starting the worker.
- Every CLI flag the desktop app accepts must be declared in the `paparam`
  command in `electron/main.js`. Unknown flags crash the packaged app.
- If a change makes something in this file or `agent_docs/` untrue, update it.

## Topic notes

Read the matching file before editing that area:

- `electron/`, `renderer/`, `workers/`, worker startup or IPC →
  [agent_docs/architecture.md](agent_docs/architecture.md)
- App updates or update UI → [agent_docs/updates.md](agent_docs/updates.md)
- `forge.config.js`, `build/`, `flatpak/`, signing →
  [agent_docs/packaging.md](agent_docs/packaging.md)
- `.github/` or releasing → [agent_docs/releases.md](agent_docs/releases.md)
