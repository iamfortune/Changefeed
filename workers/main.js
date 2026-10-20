// Desktop host for backend/. Runs in a Bare worker started by electron/main.js.
// Based on https://github.com/holepunchto/hello-pear-worker.
//
// IPC protocol: one message per FramedStream frame.
//
// Updater messages (plain strings):
//   worker → app   'updating'                     an update is downloading
//   worker → app   'updated'                      update ready, restart to apply
//   app → worker   'pear:applyUpdate'             swap in the new build
//   worker → app   'pear:updateApplied'           swap done, app can relaunch
//   worker → app   'pear:updateFailed:<message>'  swap failed
//
// App messages (JSON):
//   app → worker   { id, type, payload }              request
//   worker → app   { type: 'reply', id, ok, payload } reply (ok: false → payload.message)
//
//   requests:
//     'init'         → { version, update, own: feedInfo|null, feeds: [feedInfo] }
//                       update: null | 'updating' | 'updated'
//     'create-feed'  { name }                  → feedInfo
//     'publish'      { version, title, body }  → note
//     'subscribe'    { id }                    → feedInfo
//     'notes'        { id }                    → [note] (newest first)
//
//   events (worker → app):
//     { type: 'note',  payload: { feed, note } }
//     { type: 'feed',  payload: feedInfo }
//     { type: 'peers', payload: { feed, peers } }
//
//   feedInfo = { id, name, writable, peers }
//   note     = { version, title, body, createdAt }

const PearRuntime = require('pear-runtime')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const { isBareKit } = require('which-runtime')
const Changefeed = require('../backend')

// On desktop, argv[0] and argv[1] are the executable and entry paths.
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

// Argument order must match getWorker() in electron/main.js.
const updaterConfig = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4) || dir.persistent(),
  app: argv(5)
}

const pipe = new FramedStream(Bare.IPC)
const store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime', 'corestore'))
const swarm = new Hyperswarm()
const pear = new PearRuntime({
  ...updaterConfig,
  swarm,
  store,
  // Check for updates immediately. Without this, installs wait a random delay
  // of up to an hour so a release doesn't reach everyone at once.
  delay: 0
})

// One replication stream per connection carries both app updates and feeds,
// so feeds still sync when updates are off (`npm start`).
swarm.on('connection', (connection) => store.replicate(connection))

pear.updater.on('error', console.error)
if (updaterConfig.updates) {
  swarm.join(pear.updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
}

console.log('Application storage:', pear.storage)

// Updater events fire once. Remember the last one so a window opened later
// can still show the update banner.
let update = null
pear.updater.on('updating', () => {
  update = 'updating'
  pipe.write('updating')
})
pear.updater.on('updated', () => {
  update = 'updated'
  pipe.write('updated')
})

// A namespace keeps feed core names apart from the updater's.
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
      update,
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

// Exit when the app goes away (crash, force quit) so the worker doesn't keep
// running and holding the storage lock. The pipe is half-open, so 'close'
// never fires when only the app side closes: listen for 'end'.
pipe.on('end', () => goodbye.exit())
pipe.on('error', (err) => console.error('IPC pipe:', err.message))

pipe.on('data', async (data) => {
  const message = data.toString()
  if (message === 'pear:applyUpdate') {
    try {
      await pear.ready()
      await pear.updater.applyUpdate()
      pipe.write('pear:updateApplied')
    } catch (err) {
      pipe.write('pear:updateFailed:' + err.message)
    }
    return
  }

  let request = null
  try {
    request = JSON.parse(message)
  } catch {
    console.log(message)
    return
  }
  onRequest(request)
})
