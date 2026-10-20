// Changefeed backend, shared by the desktop worker and the CLI.
//
// A feed is a Hyperbee on a single-writer Hypercore. The maintainer holds the
// only writable copy; subscribers keep full read-only copies on disk.
//
// The host passes in a Corestore and a Hyperswarm and wires replication once:
//   swarm.on('connection', (conn) => store.replicate(conn))
// This module only joins and leaves feed topics.
//
// Events:
//   'note'  ({ feed, note })    a note we didn't have before (local or remote)
//   'feed'  (feedInfo)          a feed's name changed
//   'peers' ({ feed, peers })   number of peers connected for that feed

const EventEmitter = require('events')
const Hyperbee = require('hyperbee')
const id = require('hypercore-id-encoding')

const NOTE_PREFIX = 'note!'
const NOTE_RANGE = { gt: NOTE_PREFIX, lt: NOTE_PREFIX + '\xff' }
const SUB_PREFIX = 'sub!'

// Keys sort as bytes, so a zero-padded timestamp keeps notes in time order.
function noteKey(createdAt) {
  return NOTE_PREFIX + String(createdAt).padStart(15, '0')
}

class Feed {
  constructor(bee) {
    this.bee = bee
    this.core = bee.core
    this.id = id.encode(bee.core.key)
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

    // Which feeds this device owns and follows. Never shared with peers.
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

  // Creates this device's feed, or returns it if it already exists.
  // The same storage always gives the same feed key.
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

    // Two publishes in the same millisecond would share a key.
    const last = await this.ownFeed.bee.peek(NOTE_RANGE, { reverse: true })
    if (last && last.value.createdAt >= note.createdAt) note.createdAt = last.value.createdAt + 1

    await this.ownFeed.bee.put(noteKey(note.createdAt), note)
    return note
  }

  // Follows a feed by key. Notes arrive as 'note' events once peers are found.
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

  list() {
    return [...this.feeds.values()].map((f) => f.info())
  }

  // Newest first, from local storage, so it works offline.
  async notes(feedId) {
    await this.ready()
    const feed = this.feeds.get(feedId)
    if (!feed) throw new Error('Unknown feed: ' + feedId)

    const notes = []
    for await (const { value } of feed.bee.createReadStream(NOTE_RANGE, { reverse: true })) {
      notes.push(value)
    }
    return notes
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this._opening.catch(() => {})
    for (const feed of this.feeds.values()) {
      await this.swarm.leave(feed.core.discoveryKey)
      if (feed.download) feed.download.destroy()
      if (feed.watcher) await feed.watcher.close()
      await feed.bee.close()
    }
    await this.local.close()
  }

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

    // Subscribers download the whole feed, including future notes, so it
    // works offline.
    if (!core.writable) feed.download = core.download({ start: 0, end: -1 })

    const onPeers = () => this.emit('peers', { feed: feed.id, peers: core.peers.length })
    core.on('peer-add', onPeers)
    core.on('peer-remove', onPeers)

    const info = await bee.get('info')
    if (info) feed.name = info.value.name

    this._watch(feed)

    // Every peer also serves the feed, so subscribers can sync from each
    // other while the maintainer is offline.
    const done = core.findingPeers()
    this.swarm.join(core.discoveryKey)
    this.swarm.flush().then(done, done)

    return feed
  }

  // Emits 'note' for each new note, local or from a peer.
  async _watch(feed) {
    feed.watcher = feed.bee.watch()
    try {
      for await (const [current, previous] of feed.watcher) {
        for await (const { left, right } of current.createDiffStream(previous.version)) {
          if (!left) continue
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
