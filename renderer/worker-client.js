// Talks to the Bare worker through window.bridge (electron/preload.js).
// Protocol is documented at the top of workers/main.js.

const bridge = window.bridge
const decoder = new TextDecoder('utf-8')
const WORKER = '/workers/main.js'

let nextId = 1
const pending = new Map() // request id -> { resolve, reject }
const listeners = new Map() // event type -> Set(fn)

function emit(type, payload) {
  for (const fn of listeners.get(type) || []) fn(payload)
}

function request(type, payload) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    bridge.writeWorkerIPC(WORKER, JSON.stringify({ id, type, payload }))
  })
}

function onMessage(text) {
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    // The template's plain-string updater messages: 'updating', 'updated'.
    return emit('updater', text)
  }
  if (msg.type === 'reply') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.payload)
    else p.reject(new Error(msg.payload.message))
    return
  }
  emit(msg.type, msg.payload)
}

bridge.startWorker(WORKER)

const offStdout = bridge.onWorkerStdout(WORKER, (data) => {
  console.log('worker:', decoder.decode(data))
})
const offStderr = bridge.onWorkerStderr(WORKER, (data) => {
  console.error('worker:', decoder.decode(data))
})
const offIpc = bridge.onWorkerIPC(WORKER, (data) => onMessage(decoder.decode(data)))
const offExit = bridge.onWorkerExit(WORKER, (code) => {
  for (const p of pending.values()) p.reject(new Error('Worker exited'))
  pending.clear()
  offStdout()
  offStderr()
  offIpc()
  offExit()
  emit('exit', code)
})

export const cf = {
  init: () => request('init'),
  createFeed: (name) => request('create-feed', { name }),
  publish: (note) => request('publish', note),
  subscribe: (id) => request('subscribe', { id }),
  notes: (id) => request('notes', { id }),
  // events: 'note', 'feed', 'peers', 'updater', 'exit'
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
    return () => listeners.get(type).delete(fn)
  },
  applyUpdate: () => bridge.applyUpdate(),
  appAfterUpdate: () => bridge.appAfterUpdate(),
  version: bridge.pkg().version
}
