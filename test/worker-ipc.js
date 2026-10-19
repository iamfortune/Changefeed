// Drives two real workers/main.js processes over IPC, the same way
// electron/main.js does (PearRuntime.run + six spawn args + FramedStream),
// with no window. Run with: node test/worker-ipc.js
//
// Worker 1 creates a feed and publishes; worker 2 subscribes by key and
// must receive the note, then a second one live.

const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pkg = require('../package.json')

const root = path.join(os.tmpdir(), 'changefeed-ipc-' + Date.now())
const started = Date.now()
const log = (...a) => console.log('[' + ((Date.now() - started) / 1000).toFixed(1) + 's]', ...a)

function startWorker(name) {
  const worker = PearRuntime.run(require.resolve('../workers/main.js'), [
    false, // updates off, like `npm start`
    pkg.version,
    pkg.upgrade,
    pkg.productName + '.app',
    path.join(root, name),
    null
  ])
  const pipe = new FramedStream(worker)
  const pending = new Map()
  const events = []
  const waiters = []
  let nextId = 1

  worker.stderr.on('data', (d) => log(name, 'stderr:', d.toString().trim()))
  pipe.on('data', (data) => {
    const text = data.toString()
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return log(name, 'string:', text)
    }
    if (msg.type === 'reply') {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      return msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.payload.message))
    }
    log(name, 'event', msg.type, JSON.stringify(msg.payload))
    events.push(msg)
    for (const w of [...waiters]) w()
  })

  return {
    request(type, payload) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        pipe.write(JSON.stringify({ id, type, payload }))
      })
    },
    waitFor(pred, ms = 60000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(name + ': timed out')), ms)
        const check = () => {
          const hit = events.find(pred)
          if (!hit) return
          clearTimeout(timer)
          waiters.splice(waiters.indexOf(check), 1)
          resolve(hit)
        }
        waiters.push(check)
        check()
      })
    },
    stop() {
      return new Promise((resolve) => {
        worker.once('exit', resolve)
        pipe.destroy()
      })
    }
  }
}

function assert(ok, msg) {
  if (!ok) throw new Error('FAIL: ' + msg)
  log('ok -', msg)
}

async function main() {
  const w1 = startWorker('one')
  const w2 = startWorker('two')

  const s1 = await w1.request('init')
  assert(s1.version === pkg.version && s1.own === null, 'worker 1 init: no feed yet')
  assert(s1.update === null, 'worker 1 init: no pending update')

  const own = await w1.request('create-feed', { name: 'IPC test feed' })
  log('feed', own.id)
  await w1.request('publish', { version: '1.0.0', title: 'Over IPC', body: 'hello' })
  await w1.request('create-feed', { name: 'ignored' }).then((f) => {
    assert(f.id === own.id, 'create-feed is idempotent')
  })
  const bad = await w1.request('publish', { title: 'no version' }).catch((e) => e)
  assert(bad instanceof Error && /version/.test(bad.message), 'errors come back as rejections')

  // Let worker 1's DHT announce land first (see test/two-peers.js).
  await new Promise((r) => setTimeout(r, 5000))

  await w2.request('init')
  await w2.request('subscribe', { id: own.id })
  await w2.waitFor((e) => e.type === 'note' && e.payload.note.version === '1.0.0')
  assert(true, 'worker 2 received the existing note')

  await w1.request('publish', { version: '1.0.1', title: 'Live over IPC' })
  await w2.waitFor((e) => e.type === 'note' && e.payload.note.version === '1.0.1')
  assert(true, 'worker 2 received a live note')

  const notes = await w2.request('notes', { id: own.id })
  assert(notes.length === 2 && notes[0].version === '1.0.1', 'notes request: newest first')

  await Promise.all([w1.stop(), w2.stop()])
  fs.rmSync(root, { recursive: true, force: true })
  log('PASS')
}

main().catch((err) => {
  console.error(err)
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(1)
})
