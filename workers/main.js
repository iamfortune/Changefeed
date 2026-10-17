// Desktop host for the Changefeed backend. Runs in a Bare worker spawned by
// electron/main.js; Electron itself never touches P2P code.
//
// Based on https://github.com/holepunchto/hello-pear-worker, extended to:
// - share one Corestore + Hyperswarm between the OTA updater and backend/
// - translate IPC messages into backend/ calls and backend events into IPC
//
// ---------------------------------------------------------------------------
// IPC protocol (FramedStream over Bare.IPC, one message per frame)
//
// Template contract, plain UTF-8 strings (electron/main.js and the renderer
// match these exactly, so they stay as-is):
//   worker → app   'updating'             an update is downloading
//   worker → app   'updated'              update ready, restart to apply
//   app → worker   'pear:applyUpdate'     swap in the new build
//   worker → app   'pear:updateApplied'   swap done, app can relaunch
//
// App messages, JSON:
//   app → worker   { id, type, payload }              request
//   worker → app   { type: 'reply', id, ok, payload } reply (ok: false → payload.message)
//
//   requests:
//     'init'         → { version, own: feedInfo|null, feeds: [feedInfo] }
//     'create-feed'  { name }                  → feedInfo
//     'publish'      { version, title, body }  → note
//     'subscribe'    { id }                    → feedInfo
//     'notes'        { id }                    → [note] (newest first)
//
//   events (worker → app, unprompted):
//     { type: 'note',  payload: { feed, note } }
//     { type: 'feed',  payload: feedInfo }
//     { type: 'peers', payload: { feed, peers } }
//
//   feedInfo = { id, name, writable, peers }
//   note     = { version, title, body, createdAt }
// ---------------------------------------------------------------------------

const PearRuntime = require('pear-runtime') // pear-runtime on desktop; pear-mobile on mobile
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const { isBareKit } = require('which-runtime')
const Changefeed = require('../backend')

// Mobile workers don't get the executable path (argv[0]) and entry path
// (argv[1]), so desktop args start at index 2.
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

// Spawn order is a contract with getWorker() in electron/main.js.
const updaterConfig = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4) || dir.persistent(), // argv[4] is undefined in mobile
  app: argv(5) // argv[5] is undefined in mobile
}

const pipe = new FramedStream(Bare.IPC)
const store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime', 'corestore'))
const swarm = new Hyperswarm()
const pear = new PearRuntime({ ...updaterConfig, swarm, store })

// One replication stream per connection for the whole Corestore. It carries
// both the app drive (OTA updates) and our feeds. In the template this line
// sits inside the `updates` check below; it is hoisted so feeds replicate
// even when updates are off (e.g. `npm start`, which passes --no-updates).
swarm.on('connection', (connection) => store.replicate(connection))

pear.updater.on('error', console.error)
if (updaterConfig.updates !== false) {
  // Only look for the app drive (where releases live) when updates are on.
  swarm.join(pear.updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
}

console.log('Application storage:', pear.storage)

pear.updater.on('updating', () => pipe.write('updating'))
pear.updater.on('updated', () => pipe.write('updated'))

// A namespace keeps our core names from colliding with the updater's.
// Same underlying store, so the replication above covers it.
const changefeed = new Changefeed(store.namespace('changefeed'), swarm)

function send(type, payload) {
  pipe.write(JSON.stringify({ type, payload }))
}

changefeed.on('note', (e) => send('note', e))
changefeed.on('feed', (info) => send('feed', info))
changefeed.on('peers', (e) => send('peers', e))
changefeed.on('error', console.error)

const handlers = {
  async init() {
    await changefeed.ready()
    return {
      version: updaterConfig.version,
      own: changefeed.getOwnFeed(),
      feeds: changefeed.list()
    }
  },
  'create-feed': (p) => changefeed.createFeed(p),
  publish: (p) => changefeed.publish(p),
  subscribe: (p) => changefeed.subscribe(p.id),
  notes: (p) => changefeed.notes(p.id)
}

async function onRequest({ id, type, payload = {} }) {
  const handler = handlers[type]
  try {
    if (!handler) throw new Error('Unknown request: ' + type)
    const result = await handler(payload)
    pipe.write(JSON.stringify({ type: 'reply', id, ok: true, payload: result }))
  } catch (err) {
    pipe.write(JSON.stringify({ type: 'reply', id, ok: false, payload: { message: err.message } }))
  }
}

goodbye(async () => {
  await changefeed.close()
  await swarm.destroy()
  await pear.close()
  await store.close()
})

pipe.on('data', async (data) => {
  const message = data.toString()
  if (message === 'pear:applyUpdate') {
    await pear.ready()
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
    return
  }

  let request = null
  try {
    request = JSON.parse(message)
  } catch {
    console.log(message) // not JSON: log it, like the template does
    return
  }
  onRequest(request)
})
