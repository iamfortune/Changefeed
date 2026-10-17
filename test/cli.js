// End-to-end: the CLI (cli/bin.mjs on the app's Bare) follows a feed that a
// maintainer worker publishes. Run with: node test/cli.js
//
// 1. maintainer creates a feed, publishes 2 notes
// 2. CLI subscribes and prints both
// 3. maintainer publishes a 3rd; CLI prints it as new
// 4. Ctrl+C (SIGINT to the process group): CLI exits cleanly
// 5. maintainer gone; CLI restarts offline and still prints all 3

const { spawn } = require('child_process')
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pkg = require('../package.json')

const root = path.join(os.tmpdir(), 'changefeed-cli-test-' + Date.now())
const started = Date.now()
const log = (...a) => console.log('[' + ((Date.now() - started) / 1000).toFixed(1) + 's]', ...a)

function assert(ok, msg) {
  if (!ok) throw new Error('FAIL: ' + msg)
  log('ok -', msg)
}

function startMaintainer() {
  const worker = PearRuntime.run(require.resolve('../workers/main.js'), [
    false,
    pkg.version,
    pkg.upgrade,
    pkg.productName + '.app',
    path.join(root, 'maintainer'),
    null
  ])
  const pipe = new FramedStream(worker)
  const pending = new Map()
  let nextId = 1
  pipe.on('data', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type !== 'reply') return
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.payload.message))
  })
  return {
    request(type, payload) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        pipe.write(JSON.stringify({ id, type, payload }))
      })
    },
    stop: () =>
      new Promise((resolve) => {
        worker.once('exit', resolve)
        pipe.destroy()
      })
  }
}

function startCli(key) {
  // detached: own process group, so we can send SIGINT to the whole group
  // like a terminal's Ctrl+C does.
  const child = spawn(
    'node',
    [
      path.join(__dirname, '..', 'scripts', 'app-bare.js'),
      path.join(__dirname, '..', 'cli', 'bin.mjs'),
      'subscribe',
      key,
      '--storage',
      path.join(root, 'cli')
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
    for (const line of d.toString().split('\n')) if (line.trim()) log('  cli |', line)
  })
  child.stderr.on('data', (d) => log('  cli stderr |', d.toString().trim()))
  const exited = new Promise((resolve) => child.once('exit', resolve))
  return {
    output: () => out,
    async waitFor(re, ms = 60000) {
      const end = Date.now() + ms
      while (!re.test(out)) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + re)
        await new Promise((r) => setTimeout(r, 250))
      }
    },
    ctrlC() {
      process.kill(-child.pid, 'SIGINT')
      return exited
    }
  }
}

async function main() {
  const m = startMaintainer()
  const feed = await m.request('create-feed', { name: 'CLI test feed' })
  await m.request('publish', { version: '1.0.0', title: 'First', body: 'line one\nline two' })
  await m.request('publish', { version: '1.0.1', title: 'Second' })
  log('maintainer feed', feed.id)
  await new Promise((r) => setTimeout(r, 5000)) // let the announce land

  const cli = startCli(feed.id)
  await cli.waitFor(/1\.0\.1\s+Second/)
  assert(/1\.0\.0\s+First/.test(cli.output()), 'CLI printed both existing notes')
  assert(!/● new/.test(cli.output()), 'existing notes are not marked new')

  await m.request('publish', { version: '1.0.2', title: 'Live one' })
  await cli.waitFor(/● new 1\.0\.2\s+Live one/)
  assert(true, 'CLI printed the live note as new')

  const code = await cli.ctrlC()
  assert(code === 0, 'Ctrl+C exits cleanly (code 0)')

  await m.stop()
  log('maintainer stopped')

  const offline = startCli(feed.id)
  await offline.waitFor(/Listening for new notes/)
  const out = offline.output()
  assert(
    /1\.0\.0\s+First/.test(out) && /1\.0\.1\s+Second/.test(out) && /1\.0\.2\s+Live one/.test(out),
    'CLI restarted offline and printed all 3 notes from disk'
  )
  assert(await offline.ctrlC().then((c) => c === 0), 'offline CLI exits cleanly')

  fs.rmSync(root, { recursive: true, force: true })
  log('PASS')
}

main().catch((err) => {
  console.error(err)
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(1)
})
