/**
 * Output that has to survive process.exit().
 *
 * console.log on a pipe queues the write and returns, so printing a big JSON document and exiting
 * immediately truncates it at the pipe buffer - and only sometimes, depending on how fast the
 * reader drains. That is how `--config-schema | jq` used to lose everything past ~8 KB.
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

    test('console.log in the same place does not - which is why this exists', () => {
        const size = 200000;
        const out = runThroughPipe(`
            console.log('x'.repeat(${size}));
            process.exit(0);
        `);
        assert.ok(out.length < size, `console.log wrote ${out.length} of ${size} - the bug would be gone`);
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
