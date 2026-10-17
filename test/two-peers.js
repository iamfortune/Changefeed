// End-to-end check of backend/ with two independent peers over the real DHT.
//
//   npm test            (runs under Bare — the runtime the app ships with)
//   node test/two-peers.js
//
// A and B each get their own storage dir, Corestore and Hyperswarm: exactly
// what two separate devices would have.
//
// 1. A creates a feed and publishes 2 notes
// 2. B subscribes by key and receives both
// 3. A publishes a 3rd note, B receives it live
// 4. A goes away for good; B restarts from disk alone and still has all 3

const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Changefeed = require('../backend')

const runtime = typeof Bare !== 'undefined' ? 'Bare ' + Bare.version : 'Node ' + process.version
const root = path.join(os.tmpdir(), 'changefeed-test-' + Date.now())

function log(...args) {
  console.log('[' + ((Date.now() - started) / 1000).toFixed(1) + 's]', ...args)
}

function assert(ok, msg) {
  if (!ok) throw new Error('FAIL: ' + msg)
  log('ok -', msg)
}

// Resolves with the first `count` events matching `filter`, or rejects after `ms`.
function waitFor(emitter, event, count, filter, ms = 60000) {
  return new Promise((resolve, reject) => {
    const seen = []
    const timer = setTimeout(() => {
      emitter.off(event, on)
      reject(new Error(`timed out waiting for ${count} '${event}' events (got ${seen.length})`))
    }, ms)
    function on(data) {
      if (!filter(data)) return
      seen.push(data)
      if (seen.length < count) return
      clearTimeout(timer)
      emitter.off(event, on)
      resolve(seen)
    }
    emitter.on(event, on)
  })
}

// What a host does: own the storage + swarm, wire replication once.
async function startPeer(name) {
  const store = new Corestore(path.join(root, name))
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))
  const feed = new Changefeed(store, swarm)
  feed.on('error', (err) => log(name, 'error', err))
  feed.on('peers', (e) => log(name, 'peers:', e.peers))
  await feed.ready()
  return {
    feed,
    swarm,
    async stop() {
      await feed.close()
      await swarm.destroy()
      await store.close()
    }
  }
}

const started = Date.now()

async function main() {
  log('runtime:', runtime, '| storage:', root)

  // 1. maintainer
  const a = await startPeer('a')
  const own = await a.feed.createFeed({ name: 'Changefeed test releases' })
  log('A created feed', own.id)
  // Wait until A's DHT announce has landed. B's lookup runs once when it
  // joins; if it beats A's announce it finds nobody until the next periodic
  // refresh (minutes). Real subscribers arrive long after the maintainer.
  await a.swarm.flush()
  log('A announced on the DHT')
  await a.feed.publish({ version: '1.0.0', title: 'First release', body: 'Hello peers' })
  await a.feed.publish({ version: '1.0.1', title: 'Bug fixes', body: 'Fixed things' })
  assert((await a.feed.notes(own.id)).length === 2, 'A has 2 notes locally')

  // 2. subscriber
  const b = await startPeer('b')
  const gotTwo = waitFor(b.feed, 'note', 2, (e) => e.feed === own.id)
  const sub = await b.feed.subscribe(own.id)
  assert(sub.id === own.id && sub.writable === false, 'B subscribed (read-only replica)')
  await gotTwo
  const bNotes = await b.feed.notes(own.id)
  assert(bNotes.length === 2, 'B received the 2 existing notes')
  assert(bNotes[0].version === '1.0.1', 'B lists newest first')
  assert(b.feed.list()[0].name === 'Changefeed test releases', 'B synced the feed name')

  // 3. live update
  const gotThird = waitFor(b.feed, 'note', 1, (e) => e.feed === own.id)
  await a.feed.publish({ version: '1.0.2', title: 'Live note', body: 'Arrives without refresh' })
  const [live] = await gotThird
  assert(live.note.version === '1.0.2', 'B got the 3rd note live')

  // 4. offline: A is gone, B restarts from disk with nobody to talk to
  await a.stop()
  log('A stopped')
  await b.stop()
  log('B stopped')

  const b2 = await startPeer('b')
  const feeds = b2.feed.list()
  assert(feeds.length === 1 && feeds[0].id === own.id, 'B reopened its subscription from disk')
  assert(feeds[0].peers === 0, 'B has no peers')
  const offline = await b2.feed.notes(own.id)
  assert(offline.length === 3, 'B still lists all 3 notes offline')
  log('B offline notes:', offline.map((n) => n.version + ' ' + n.title).join(' | '))
  await b2.stop()

  await fs.promises.rm(root, { recursive: true, force: true })
  log('PASS')
}

main().catch(async (err) => {
  console.error(err)
  await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {})
  // Bare has no process global; both expose an exit.
  if (typeof Bare !== 'undefined') Bare.exit(1)
  else process.exit(1)
})
