# Changefeed

**Peer-to-peer release notes.** A maintainer publishes release notes straight
from their machine; subscribers follow the feed by key, receive new notes live,
and keep every note on disk, so the feed still works offline. No server, no
accounts, no mailing list.

Built on [Pear](https://docs.pears.com) from the
[hello-pear-electron](https://github.com/holepunchto/hello-pear-electron)
template: Hyperswarm, Hyperbee and Corestore, running in a Bare worker, with
over-the-air updates delivered peer to peer.

![Subscriber view](assets/screenshot-subscriber.png)

> Work in progress: install link, CLI, architecture and release notes coming
> in the full README.

## Run from source

```sh
npm install
npm start                                  # instance 1
npm start -- --storage /tmp/changefeed-b   # instance 2, separate storage
```

In instance 1, create a feed and copy its key. In instance 2, open
**Subscribe** and paste it.

## Test

```sh
npm test
```

Runs the shared backend on the exact Bare runtime the app embeds (two peers
over the real DHT, live notes, offline reads), then drives two real worker
processes over IPC.

## Layout

| Path           | What                                                             |
| -------------- | ---------------------------------------------------------------- |
| `backend/`     | Shareable P2P core: feeds, notes, discovery. No Electron, no UI. |
| `workers/`     | Desktop host: runs `backend/` + the OTA updater in Bare.         |
| `electron/`    | Window + byte relay between renderer and worker.                 |
| `renderer/`    | UI (plain HTML/CSS/JS).                                          |
| `test/`        | Backend and worker tests.                                        |
| `RELEASING.md` | How releases are built, staged and shipped.                      |
