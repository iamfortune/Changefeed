const bridge = window.bridge
const decoder = new TextDecoder('utf-8')
const WORKER = '/workers/main.js'

document.getElementById('v').innerText += bridge.pkg().version

// ---- worker client: JSON request/reply + events (protocol in workers/main.js)

let nextId = 1
const pending = new Map() // id -> { resolve, reject }
const listeners = new Map() // event type -> Set(fn)

function request(type, payload) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    bridge.writeWorkerIPC(WORKER, JSON.stringify({ id, type, payload }))
  })
}

function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(fn)
  return () => listeners.get(type).delete(fn)
}

function onMessage(text) {
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return onWorkerUpdaterEvent(text) // template's plain-string updater messages
  }
  if (msg.type === 'reply') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.payload)
    else p.reject(new Error(msg.payload.message))
    return
  }
  for (const fn of listeners.get(msg.type) || []) fn(msg.payload)
}

const cf = {
  init: () => request('init'),
  createFeed: (name) => request('create-feed', { name }),
  publish: (note) => request('publish', note),
  subscribe: (id) => request('subscribe', { id }),
  notes: (id) => request('notes', { id }),
  on
}

// Exposed for testing from the devtools console until the UI lands.
window.cf = cf
cf.on('note', (e) => console.log('note', e))
cf.on('feed', (e) => console.log('feed', e))
cf.on('peers', (e) => console.log('peers', e))

// ---- updater (unchanged from the template)

function showUpdateReady() {
  document.getElementById('v').innerText = 'Update ready!'
  const btn = document.getElementById('update-btn')
  btn.style.display = 'inline-block'
  btn.onclick = async () => {
    btn.disabled = true
    btn.innerText = 'Updating...'
    try {
      await bridge.applyUpdate()
      await bridge.appAfterUpdate()
    } catch (err) {
      document.getElementById('v').innerText = 'Update failed: ' + err.message
      btn.style.display = 'none'
    }
  }
}

function onWorkerUpdaterEvent(name) {
  if (name === 'updating') {
    document.getElementById('v').innerText = 'UPDATING...'
    return
  }
  if (name === 'updated') showUpdateReady()
}

// ---- worker lifecycle

bridge.startWorker(WORKER)

const offWorkerStdout = bridge.onWorkerStdout(WORKER, (data) => {
  console.log('worker stdout:', decoder.decode(data))
})

const offWorkerStderr = bridge.onWorkerStderr(WORKER, (data) => {
  console.error('worker stderr:', decoder.decode(data))
})

const offWorkerIpc = bridge.onWorkerIPC(WORKER, (data) => onMessage(decoder.decode(data)))

const offWorkerExit = bridge.onWorkerExit(WORKER, (code) => {
  console.log('Worker exited with code', code)
  for (const p of pending.values()) p.reject(new Error('Worker exited'))
  pending.clear()
  offWorkerStdout()
  offWorkerStderr()
  offWorkerIpc()
  offWorkerExit()
})

cf.init().then((state) => console.log('changefeed ready', state))
