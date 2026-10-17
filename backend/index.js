// Changefeed backend: the shareable P2P core.
//
// A "feed" is a Hyperbee (a key/value B-tree stored on a single-writer
// Hypercore). The maintainer owns the only writable copy; subscribers hold
// read-only replicas that they keep on disk, so every note stays readable
// with no peers online.
//
// This module runs unchanged in the desktop Bare worker and the CLI, so it
// makes no assumptions about its host:
// - no Electron, no UI, no process/argv/env access
// - the host passes in a Corestore (storage) and a Hyperswarm (networking)
// - the HOST wires replication, once, for its whole Corestore:
//     swarm.on('connection', (conn) => store.replicate(conn))
//   The backend only decides which topics to join. This keeps a single
//   replication stream per connection even when the host shares the same
//   Corestore/swarm with other components (e.g. the pear-runtime updater).
//
// Events:
//   'note'  ({ feed, note })        a note we didn't have before (local or remote)
//   'feed'  (feedInfo)              a feed's metadata changed (e.g. name synced)
//   'peers' ({ feed, peers })       number of peers replicating that feed

const EventEmitter = require('events') // bare-events under Bare, see package.json#imports
const Hyperbee = require('hyperbee')
const id = require('hypercore-id-encoding')

const NOTE_PREFIX = 'note!'
const SUB_PREFIX = 'sub!'

// Hyperbee sorts keys by their bytes, so zero-padding the timestamp makes
// lexicographic order == chronological order. 15 digits covers any ms epoch.
function noteKey(createdAt) {
  return NOTE_PREFIX + String(createdAt).padStart(15, '0')
}

class Feed {
  constructor(bee) {
    this.bee = bee
    this.core = bee.core
    this.id = id.encode(bee.core.key) // z-base32, same alphabet as pear:// links
    this.name = null
    this.watcher = null
    this.download = null
  }

  get writable() {
    return this.core.writable
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      writable: this.writable,
      peers: this.core.peers.length
    }
  }
}

class Changefeed extends EventEmitter {
  constructor(store, swarm) {
    super()
    this.store = store
    this.swarm = swarm
    this.feeds = new Map() // id -> Feed
    this.ownFeed = null
    this.closed = false

    // Local-only bookkeeping (which feeds we own / follow), so they can be
    // reopened after a restart with no network. Nobody else knows this
    // core's key, so it never leaves this device.
    this.local = new Hyperbee(store.get({ name: 'local' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    this._opening = this._open()
  }

  ready() {
    return this._opening
  }

  async _open() {
    await this.local.ready()

    const own = await this.local.get('own')
    if (own) await this._openOwnFeed()

    for await (const { key } of this.local.createReadStream({
      gt: SUB_PREFIX,
      lt: SUB_PREFIX + '\xff'
    })) {
      await this._openFeed(id.decode(key.slice(SUB_PREFIX.length)))
    }
  }

  // ---- maintainer ---------------------------------------------------------

  // Creates this device's feed (or returns it if it already exists).
  // The core is derived from the Corestore's primary key + a fixed name,
  // so the same storage always yields the same feed key.
  async createFeed({ name } = {}) {
    await this.ready()
    if (this.ownFeed) return this.ownFeed.info()

    const feed = await this._openOwnFeed()
    await feed.bee.put('info', { name: name || 'Untitled feed' })
    await this.local.put('own', { createdAt: Date.now() })
    return feed.info()
  }

  getOwnFeed() {
    return this.ownFeed ? this.ownFeed.info() : null
  }

  async publish({ version, title, body = '' } = {}) {
    await this.ready()
    if (!this.ownFeed) throw new Error('Create a feed before publishing')
    if (typeof version !== 'string' || !version.trim()) throw new Error('version is required')
    if (typeof title !== 'string' || !title.trim()) throw new Error('title is required')

    const note = {
      version: version.trim(),
      title: title.trim(),
      body: String(body),
      createdAt: Date.now()
    }

    // Single writer, but guard against two publishes in the same millisecond
    // overwriting each other.
    const last = await this.ownFeed.bee.peek(
      { gt: NOTE_PREFIX, lt: NOTE_PREFIX + '\xff' },
      { reverse: true }
    )
    if (last && last.value.createdAt >= note.createdAt) note.createdAt = last.value.createdAt + 1

    await this.ownFeed.bee.put(noteKey(note.createdAt), note)
    return note
  }

  // ---- subscriber ---------------------------------------------------------

  // Follows a feed by key (z-base32 or hex). Returns immediately; existing
  // and future notes arrive as 'note' events once peers are found.
  async subscribe(feedId) {
    await this.ready()
    let key
    try {
      key = id.decode(feedId.trim())
    } catch {
      throw new Error('Invalid feed key')
    }

    const feed = await this._openFeed(key)
    if (!feed.writable) await this.local.put(SUB_PREFIX + feed.id, { addedAt: Date.now() })
    return feed.info()
  }

  // ---- reading ------------------------------------------------------------

  list() {
    return [...this.feeds.values()].map((f) => f.info())
  }

  // Newest first. Reads only from local storage: works offline.
  async notes(feedId) {
    await this.ready()
    const feed = this.feeds.get(feedId)
    if (!feed) throw new Error('Unknown feed: ' + feedId)

    const notes = []
    for await (const { value } of feed.bee.createReadStream(
      { gt: NOTE_PREFIX, lt: NOTE_PREFIX + '\xff' },
      { reverse: true }
    )) {
      notes.push(value)
    }
    return notes
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this._opening.catch(() => {})
    for (const feed of this.feeds.values()) {
      // Stop announcing/looking up this feed. Doesn't close the swarm:
      // the host owns it.
      await this.swarm.leave(feed.core.discoveryKey)
      if (feed.download) feed.download.destroy()
      if (feed.watcher) await feed.watcher.close()
      await feed.bee.close()
    }
    await this.local.close()
  }

  // ---- internals ----------------------------------------------------------

  async _openOwnFeed() {
    const core = this.store.get({ name: 'own-feed' })
    const feed = await this._addFeed(core)
    this.ownFeed = feed
    return feed
  }

  _openFeed(key) {
    const existing = this.feeds.get(id.encode(key))
    if (existing) return existing
    return this._addFeed(this.store.get({ key }))
  }

  async _addFeed(core) {
    const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await bee.ready()

    const feed = new Feed(bee)
    this.feeds.set(feed.id, feed)

    // Cores are sparse by default (only blocks you read are stored).
    // A release-notes feed is small and must work offline, so subscribers
    // eagerly download everything, including future appends (end: -1).
    if (!core.writable) feed.download = core.download({ start: 0, end: -1 })

    const onPeers = () => this.emit('peers', { feed: feed.id, peers: core.peers.length })
    core.on('peer-add', onPeers)
    core.on('peer-remove', onPeers)

    const info = await bee.get('info')
    if (info) feed.name = info.value.name

    this._watch(feed)

    // Discovery: the topic is the core's discovery key (a hash of the public
    // key), so peers can find each other without revealing the key itself.
    // Everyone joins as client AND server: subscribers re-serve notes to
    // other subscribers, so the feed stays available when the maintainer
    // is offline.
    const done = core.findingPeers()
    this.swarm.join(core.discoveryKey)
    this.swarm.flush().then(done, done)

    return feed
  }

  // Emits 'note' for every note that appears after the current version,
  // whether written locally or replicated from a peer.
  async _watch(feed) {
    feed.watcher = feed.bee.watch()
    try {
      for await (const [current, previous] of feed.watcher) {
        for await (const { left, right } of current.createDiffStream(previous.version)) {
          if (!left) continue // deletion: we never delete
          if (left.key.startsWith(NOTE_PREFIX)) {
            if (!right) this.emit('note', { feed: feed.id, note: left.value })
          } else if (left.key === 'info') {
            feed.name = left.value.name
            this.emit('feed', feed.info())
          }
        }
      }
    } catch (err) {
      if (!this.closed) this.emit('error', err)
    }
  }
}

module.exports = Changefeed
