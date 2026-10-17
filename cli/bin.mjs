// Changefeed CLI: follow a release-notes feed from the terminal.
//
// A second host for backend/, which runs here unchanged. Like the desktop
// worker, this host owns storage + networking and wires replication once;
// backend/ only decides what to join. Single-threaded, like the
// hello-pear-bare `single-thread` variant: no worker, no IPC, no updater
// (the CLI isn't released on its own pear:// link).
//
//   npm run cli -- subscribe <feed-key> [--storage <dir>]
//   (runs on the Bare binary the desktop app embeds: scripts/app-bare.js)

import { command, flag, arg, summary } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import path from 'bare-path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import pkg from '../package.json'
import Changefeed from '../backend/index.js'

const subscribe = command(
  'subscribe',
  summary('Print every note in a feed, then stream new ones live'),
  arg('<key>', 'feed key (as shown in the desktop app)'),
  flag('--storage <dir>', 'storage directory (default: per-user app data)')
)

const cmd = command('changefeed', summary('Peer-to-peer release notes'), subscribe)

// parse() returns the matched command; bad input (e.g. missing key) throws.
let matched
try {
  matched = cmd.parse(Bare.argv.slice(2))
} catch (err) {
  console.error(`error: ${err.message}\n\n${cmd.usage('subscribe')}`)
  Bare.exit(1)
}
if (matched === cmd && !cmd.flags.help) console.log(cmd.help()) // no subcommand
if (matched !== subscribe || subscribe.flags.help) Bare.exit(matched === null ? 1 : 0)

// ---- output -------------------------------------------------------------------

const tty = process.stdout.isTTY
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[22m` : s)
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[22m` : s)
const green = (s) => (tty ? `\x1b[32m${s}\x1b[39m` : s)

function printNote(note, live) {
  const date = new Date(note.createdAt).toISOString().replace('T', ' ').slice(0, 16)
  console.log('')
  console.log(`${live ? green('● new ') : ''}${bold(note.version)}  ${note.title}  ${dim(date)}`)
  if (note.body) console.log(note.body.replace(/^/gm, '  '))
}

// ---- run ----------------------------------------------------------------------

// Own storage, separate from the desktop app, so both can run at once.
const dir = subscribe.flags.storage || path.join(persistent(), 'changefeed-cli')

const store = new Corestore(dir)
const swarm = new Hyperswarm()
swarm.on('connection', (conn) => store.replicate(conn))
// Same namespace as the desktop worker, so a CLI pointed at a desktop
// storage dir would see the same feeds.
const changefeed = new Changefeed(store.namespace('changefeed'), swarm)
changefeed.on('error', (err) => console.error('error:', err.message))

const startedAt = Date.now()
const printed = new Set() // createdAt of notes already shown
let feedId = null

// Notes published before we started are history, even if they only reach us
// now during the first sync; anything newer is live.
changefeed.on('note', ({ feed, note }) => {
  if (feed !== feedId || printed.has(note.createdAt)) return
  printed.add(note.createdAt)
  printNote(note, note.createdAt > startedAt)
})

changefeed.on('feed', (info) => {
  if (info.id === feedId && info.name) console.log(dim(`\nFeed: ${info.name}`))
})

changefeed.on('peers', ({ feed, peers }) => {
  if (feed !== feedId) return
  console.log(
    dim(peers > 0 ? `\n[${peers} peer${peers === 1 ? '' : 's'} connected]` : '\n[offline]')
  )
})

async function stop(code = 0) {
  await changefeed.close()
  await swarm.destroy()
  await store.close()
  Bare.exit(code)
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

try {
  console.log(dim(`changefeed-cli v${pkg.version}  storage: ${dir}`))
  const info = await changefeed.subscribe(subscribe.args.key)
  if (info.writable) throw new Error('That is your own feed (this storage publishes it)')
  feedId = info.id
  console.log(bold(info.name || 'Waiting for feed…') + dim(`  ${info.id}`))

  // Whatever is already on disk: readable offline. Oldest first, like a log.
  const saved = await changefeed.notes(feedId)
  for (const note of saved.reverse()) {
    printed.add(note.createdAt)
    printNote(note, false)
  }
  if (saved.length === 0) console.log(dim('\nNo saved notes yet; looking for peers…'))

  console.log(dim('\nListening for new notes. Ctrl+C to stop.'))
} catch (err) {
  console.error('error:', err.message)
  await stop(1)
}
