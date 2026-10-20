// The CLI follows a feed that a worker publishes:
// 1. the worker creates a feed and publishes 2 notes
// 2. the CLI subscribes and prints both
// 3. the worker publishes a 3rd; the CLI prints it as new
// 4. Ctrl+C: the CLI exits cleanly
// 5. with the worker gone, the CLI restarts offline and prints all 3
//
//   node test/cli.js

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { log, assert, sleep, startWorker } = require('./helpers')

const root = path.join(os.tmpdir(), 'changefeed-cli-test-' + Date.now())

function startCli(key) {
  // Own process group, so SIGINT reaches the whole group like Ctrl+C does.
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
        await sleep(250)
      }
    },
    ctrlC() {
      process.kill(-child.pid, 'SIGINT')
      return exited
    }
  }
}

async function main() {
  const m = startWorker('maintainer', path.join(root, 'maintainer'))
  const feed = await m.request('create-feed', { name: 'CLI test feed' })
  await m.request('publish', { version: '1.0.0', title: 'First', body: 'line one\nline two' })
  await m.request('publish', { version: '1.0.1', title: 'Second' })
  log('maintainer feed', feed.id)
  await sleep(5000) // let the maintainer announce itself first

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
