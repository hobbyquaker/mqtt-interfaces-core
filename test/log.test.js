import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {createLogger, detectFormat} from '../lib/log.js';

function capture(options) {
    const lines = [];
    const log = createLogger({...options, write: (l) => lines.push(l)});
    return {log, lines};
}

describe('detectFormat', () => {
    test('journal when JOURNAL_STREAM is set and stdout is not a tty', () => {
        assert.equal(detectFormat({JOURNAL_STREAM: '8:12345'}, {isTTY: false}), 'journal');
        assert.equal(detectFormat({JOURNAL_STREAM: '8:12345'}, {isTTY: true}), 'text');
        assert.equal(detectFormat({}, {isTTY: false}), 'text');
    });
    test('<PREFIX>_LOG_FORMAT overrides', () => {
        assert.equal(detectFormat({X_LOG_FORMAT: 'journal'}, {isTTY: true}, 'X'), 'journal');
        assert.equal(detectFormat({X_LOG_FORMAT: 'text', JOURNAL_STREAM: '1:2'}, {isTTY: false}, 'X'), 'text');
        // without a prefix the override is ignored
        assert.equal(detectFormat({X_LOG_FORMAT: 'journal'}, {isTTY: true}), 'text');
    });
});

describe('journal format', () => {
    test('sd-daemon priority prefix, no timestamp, objects formatted', () => {
        const {log, lines} = capture({format: 'journal'});
        log.setLevel('debug');
        log.debug('d');
        log.info('tv connected', 'host');
        log.warn('w %d', 5);
        log.error('e', {a: 1});
        assert.deepEqual(lines, ['<7>d', '<6>tv connected host', '<4>w 5', '<3>e { a: 1 }']);
    });
    test('multi-line messages are indented so journald keeps them in one entry', () => {
        const {log, lines} = capture({format: 'journal'});
        log.info('a\nb');
        assert.deepEqual(lines, ['<6>a\n    b']);
    });
});

describe('text format', () => {
    test('timestamp and level tag, no color when disabled', () => {
        const {log, lines} = capture({format: 'text', color: false});
        log.info('hello');
        assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} <info> {2}hello$/);
    });
});

describe('levels', () => {
    test('threshold filters, getLevel reports, unknown level throws', () => {
        const {log, lines} = capture({format: 'journal', level: 'warn'});
        assert.equal(log.getLevel(), 'warn');
        log.info('nope');
        log.warn('yes');
        assert.deepEqual(lines, ['<4>yes']);
        assert.throws(() => log.setLevel('loud'));
    });
});
