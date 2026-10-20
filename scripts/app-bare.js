// Runs a script on the same Bare binary the desktop app ships with.
//
//   node scripts/app-bare.js test/two-peers.js
//   node scripts/app-bare.js cli/bin.mjs subscribe <key>
//
// This Bare build exits as soon as its pipe on fd 3 closes, so fd 3 is kept
// open. Scripts run this way must call Bare.exit() when done.

const { spawn } = require('child_process')
const path = require('path')

// Use the copy of bare-sidecar that pear-runtime depends on.
const sidecarDir = path.dirname(
  require.resolve('bare-sidecar', { paths: [path.dirname(require.resolve('pear-runtime'))] })
)
const bin = path.join(
  sidecarDir,
  'prebuilds',
  process.platform + '-' + process.arch,
  process.platform === 'win32' ? 'bare.exe' : 'bare'
)

const child = spawn(bin, process.argv.slice(2), {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe']
})
// Ctrl+C reaches the child too. Wait for it to clean up and exit.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 1))
