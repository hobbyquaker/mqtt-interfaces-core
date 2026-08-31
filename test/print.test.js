/**
 * Output that has to survive process.exit().
 *
 * Whether console.log to a pipe is synchronous is a property of the platform - node writes pipes
 * synchronously on Linux and Windows but asynchronously on macOS - so printing a big JSON document
 * and exiting immediately truncates it there at the pipe buffer, and only sometimes, depending on
 * how fast the reader drains. That is how `--config-schema | jq` lost everything past 8 KB on a
 * mac while looking fine in CI. These tests assert the outcome we do control: the whole document
 * arrives, on every platform.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const url = (file) => 'file://' + path.join(lib, file);

/** Runs a module in a child process and returns everything it wrote to stdout through a pipe. */
function runThroughPipe(source) {
    return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
}

describe('printSync', () => {
    test('a large write survives an immediate process.exit', () => {
        const size = 200000;
        const out = runThroughPipe(`
            import {printSync} from '${url('print.js')}';
            printSync('x'.repeat(${size}));
            process.exit(0);
        `);
        assert.equal(out.length, size + 1, 'stdout was truncated');
    });

    test('--config-schema reaches a pipe completely', () => {
        // enough options that the schema is far past a pipe buffer
        const many = Array.from(
            {length: 200},
            (_, i) => `'option-${i}': {type: 'string', describe: 'option number ${i} of a wide adapter'}`,
        ).join(',');
        const out = runThroughPipe(`
            import {parseConfig} from '${url('config.js')}';
            parseConfig({
                pkg: {name: 'foo2mqtt', version: '1.0.0', description: 'Foo to MQTT'},
                options: {${many}},
                argv: ['--config-schema'],
                env: {},
            });
        `);
        assert.ok(out.length > 16384, `schema was only ${out.length} bytes`);
        const schema = JSON.parse(out); // the actual regression: this used to throw
        assert.equal(Object.keys(schema.properties).length > 200, true);
    });
});
