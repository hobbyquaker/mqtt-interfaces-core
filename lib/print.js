/**
 * Writing to stdout when the process is about to exit.
 */

import fs from 'node:fs';

/**
 * Writes a line to stdout and, unlike `console.log`, is finished when it returns.
 *
 * `console.log` on a pipe is asynchronous: it queues the write and returns, so a `process.exit()`
 * right after it throws away whatever the pipe buffer could not take - `--config-schema | jq` then
 * loses everything past ~8 KB, and does so non-deterministically, depending on how fast the reader
 * drains. Every "print and exit" path writes synchronously instead.
 *
 * @param {string} text
 */
export function printSync(text) {
    const buffer = Buffer.from(String(text) + '\n', 'utf8');
    let written = 0;
    while (written < buffer.length) {
        try {
            written += fs.writeSync(1, buffer, written, buffer.length - written);
        } catch (error) {
            if (error.code === 'EAGAIN') {
                // stdout is a non-blocking pipe and full: wait a moment for the reader
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
                continue;
            }
            if (error.code === 'EPIPE') {
                return; // the reader is gone (`| head`), which is not our problem
            }
            throw error;
        }
    }
}
