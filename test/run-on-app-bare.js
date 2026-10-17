// Runs a script on the exact Bare binary the desktop app embeds
// (bare-sidecar, via pear-runtime), not a separately installed `bare`.
// Dependencies can require a minimum Bare version, so testing on a
// different Bare than the one users get can hide startup failures.
//
//   node test/run-on-app-bare.js test/two-peers.js
//
// The sidecar build of Bare expects an IPC pipe on fd 3 and calls Bare.exit()
// as soon as that pipe closes (bare-sidecar/lib/runtime.js). So we must give it
// an fd 3 that stays open, or the script is cut off mid-run with exit code 0
// (a silent false pass). An open pipe also keeps the child alive, so scripts
// run this way must call Bare.exit() themselves when done.

const { spawn } = require('child_process')
const path = require('path')

// Resolve bare-sidecar the way pear-runtime does, so we get its copy.
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
child.on('exit', (code) => process.exit(code ?? 1))
