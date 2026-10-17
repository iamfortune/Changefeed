// Runs a script on the exact Bare binary the desktop app embeds
// (bare-sidecar, via pear-runtime), not a separately installed `bare`.
// Dependencies can require a minimum Bare version, so testing on a
// different Bare than the one users get can hide startup failures.
//
//   node test/run-on-app-bare.js test/two-peers.js
//
// We spawn the binary directly rather than through the Sidecar class: Sidecar
// opens an IPC pipe that keeps the child alive after the script finishes.

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

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
