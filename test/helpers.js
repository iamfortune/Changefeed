// Shared helpers for the Node tests that drive workers/main.js over IPC.

const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')
const pkg = require('../package.json')

const started = Date.now()

function log(...args) {
  console.log('[' + ((Date.now() - started) / 1000).toFixed(1) + 's]', ...args)
}

function assert(ok, msg) {
  if (!ok) throw new Error('FAIL: ' + msg)
  log('ok -', msg)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Starts the worker the way electron/main.js does, with updates off.
function startWorker(name, storage) {
  const worker = PearRuntime.run(require.resolve('../workers/main.js'), [
    false,
    pkg.version,
    pkg.upgrade,
    pkg.productName + '.app',
    storage,
    null
  ])
  const pipe = new FramedStream(worker)
  const pending = new Map()
  const events = []
  const waiters = new Set()
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
    for (const check of waiters) check()
  })

  return {
    request(type, payload) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        pipe.write(JSON.stringify({ id, type, payload }))
      })
    },
    // Resolves with the first event matching `pred`, past or future.
    waitFor(pred, ms = 60000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(name + ': timed out'))
        }, ms)
        function check() {
          const hit = events.find(pred)
          if (!hit) return
          clearTimeout(timer)
          waiters.delete(check)
          resolve(hit)
        }
        waiters.add(check)
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

module.exports = { log, assert, sleep, startWorker }
