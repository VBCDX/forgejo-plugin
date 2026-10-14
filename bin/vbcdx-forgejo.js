#!/usr/bin/env node
// Executable entry point. Keeps process wiring out of the CLI logic so the
// logic stays unit-testable.

import { main } from '../src/cli.js';

// exitCode, not process.exit(): stdout to a pipe is asynchronous, and exiting
// right after a large write (the ~145 KB manifest) dropped everything past the
// first 64 KiB. Node exits on its own once the write has drained.
main(process.argv.slice(2))
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((err) => {
    // Never leak a stack or a value to stdout; a redacted line to stderr only.
    const msg = err && err.message ? String(err.message) : String(err);
    process.stderr.write(`vbcdx-forgejo: fatal: ${msg.slice(0, 300)}\n`);
    process.exitCode = 1;
  });
