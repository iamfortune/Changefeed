// Drives two workers/main.js processes over IPC, the same way the desktop
// app does, with no window. Worker one publishes; worker two subscribes and
// must receive an existing note and a live one.
//
//   node test/worker-ipc.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const pkg = require('../package.json')
const { log, assert, sleep, startWorker } = require('./helpers')

const root = path.join(os.tmpdir(), 'changefeed-ipc-' + Date.now())

async function main() {
  const w1 = startWorker('one', path.join(root, 'one'))
  const w2 = startWorker('two', path.join(root, 'two'))

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

  // Give worker one time to announce itself before worker two looks it up.
  await sleep(5000)

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
