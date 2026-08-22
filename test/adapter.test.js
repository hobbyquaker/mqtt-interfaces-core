import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {createAdapter} from '../lib/adapter.js';
import {createLogger} from '../lib/log.js';
import {entity} from '../lib/hadiscovery.js';

const pkg = {name: 'foo2mqtt', version: '1.0.0', homepage: 'https://github.com/x/foo2mqtt'};

class FakeMqtt extends EventEmitter {
    constructor() {
        super();
        this.published = [];
        this.subscribed = [];
        this.ended = false;
    }
    publish(topic, payload, options, cb) {
        this.published.push({topic, payload, options});
        if (cb) {
            cb();
        }
    }
    subscribe(topics) {
        this.subscribed.push(...(Array.isArray(topics) ? topics : [topics]));
    }
    end(_force, _opts, cb) {
        this.ended = true;
        if (cb) {
            cb();
        }
    }
    // test helper: deliver a message
    deliver(topic, payload) {
        this.emit('message', topic, Buffer.from(String(payload)));
    }
    last(topic) {
        const hits = this.published.filter((p) => p.topic === topic);
        return hits.length > 0 ? hits[hits.length - 1] : undefined;
    }
}

function setup(overrides = {}, configOverrides = {}) {
    const client = new FakeMqtt();
    const lines = [];
    const log = createLogger({format: 'journal', level: 'debug', write: (l) => lines.push(l)});
    const config = {
        name: 'foo',
        mqttUrl: 'mqtt://test',
        jsonPayloads: false,
        haDiscovery: true,
        haPrefix: 'homeassistant',
        maintenance: true,
        verbosity: 'debug',
        ...configOverrides,
    };
    const sets = [];
    const adapter = createAdapter({
        pkg,
        config,
        log,
        deviceLabel: 'dev',
        info: {device: '10.0.0.1'},
        discovery: ({get}) => ({
            device: {mf: 'ACME', ...(get('model') && {mdl: get('model')})},
            components: {
                volume: entity({id: 'foo2mqtt_foo', name: 'foo', item: 'volume', platform: 'number', label: 'Volume'}),
            },
        }),
        discoveryTriggers: ['model'],
        onSet: (parts, value, topic) => {
            sets.push({parts, value, topic});
            if (value === 'boom') {
                throw new Error('kaboom');
            }
        },
        mqttConnect: () => client,
        ...overrides,
    });
    // signal handlers would accumulate across tests
    const onSpy = process.on;
    process.on = () => process;
    adapter.start();
    process.on = onSpy;
    return {adapter, client, lines, sets, config};
}

describe('lifecycle', () => {
    test('connect publishes connected 1, info, subscriptions, discovery', () => {
        const {client, adapter} = setup();
        client.emit('connect');
        assert.equal(client.last('foo/connected').payload, '1');
        assert.equal(client.last('foo/connected').options.retain, true);
        const info = JSON.parse(client.last('foo/info').payload);
        assert.equal(info.name, 'foo2mqtt');
        assert.equal(info.version, '1.0.0');
        assert.equal(info.spec, '2.0');
        assert.equal(info.device, '10.0.0.1');
        assert.equal(info.maintenance, true);
        assert.ok(info.started && info.host && info.pid && info.node);
        assert.deepEqual(client.subscribed, ['foo/set/#', 'foo/maintenance/set/+']);
        const disc = client.last('homeassistant/device/foo2mqtt_foo/config');
        const payload = JSON.parse(disc.payload);
        assert.deepEqual(payload.dev, {ids: ['foo2mqtt_foo'], name: 'foo', mf: 'ACME'});
        assert.equal(payload.cmps.volume.stat_t, 'foo/status/volume');
        assert.equal(adapter.mqttConnected, true);
    });

    test('device connected → 2, disconnected → 1, no duplicate publishes', () => {
        const {client, adapter} = setup();
        client.emit('connect');
        adapter.setDeviceConnected(true);
        assert.equal(client.last('foo/connected').payload, '2');
        const n = client.published.length;
        adapter.setDeviceConnected(true);
        assert.equal(client.published.length, n);
        adapter.setDeviceConnected(false);
        assert.equal(client.last('foo/connected').payload, '1');
    });

    test('status before mqtt connect is tracked and published on connect', () => {
        const {client, adapter} = setup();
        adapter.pubStatus('volume', 7);
        assert.equal(client.last('foo/status/volume'), undefined);
        client.emit('connect');
        assert.equal(client.last('foo/status/volume').payload, '7');
    });

    test('reconnect re-publishes status', () => {
        const {client, adapter} = setup();
        client.emit('connect');
        adapter.pubStatus('volume', 3);
        client.published.length = 0;
        client.emit('connect');
        assert.equal(client.last('foo/status/volume').payload, '3');
    });

    test('json payloads', () => {
        const {client, adapter} = setup({}, {jsonPayloads: true});
        client.emit('connect');
        adapter.pubStatus('mute', true);
        const p = JSON.parse(client.last('foo/status/mute').payload);
        assert.equal(p.val, true);
        assert.ok(p.ts && p.lc);
    });

    test('discovery trigger re-publishes, --no-ha-discovery clears', () => {
        const {client, adapter} = setup();
        client.emit('connect');
        client.published.length = 0;
        adapter.pubStatus('volume', 1);
        assert.equal(client.last('homeassistant/device/foo2mqtt_foo/config'), undefined);
        adapter.pubStatus('model', 'X1');
        const payload = JSON.parse(client.last('homeassistant/device/foo2mqtt_foo/config').payload);
        assert.equal(payload.dev.mdl, 'X1');

        const off = setup({}, {haDiscovery: false});
        off.client.emit('connect');
        assert.equal(off.client.last('homeassistant/device/foo2mqtt_foo/config').payload, '');
    });
});

describe('incoming', () => {
    test('set topics are parsed and dispatched, failures logged at warn', () => {
        const {client, sets, lines} = setup();
        client.emit('connect');
        client.deliver('foo/set/volume', '12');
        client.deliver('foo/set/x/y', '{"val": "a"}');
        client.deliver('foo/set/volume', 'boom');
        assert.deepEqual(sets[0], {parts: ['volume'], value: 12, topic: 'foo/set/volume'});
        assert.deepEqual(sets[1], {parts: ['x', 'y'], value: 'a', topic: 'foo/set/x/y'});
        return new Promise((resolve) =>
            setImmediate(() => {
                assert.ok(lines.some((l) => l.includes('<4>dev set volume failed: kaboom')));
                resolve();
            }),
        );
    });

    test('unexpected topics are ignored with a warning', () => {
        const {client, sets, lines} = setup();
        client.emit('connect');
        client.deliver('foo/status/volume', '1');
        client.deliver('bar/set/volume', '1');
        client.deliver('foo/set', '1');
        assert.equal(sets.length, 0);
        assert.equal(lines.filter((l) => l.includes('ignoring unexpected topic')).length, 3);
    });

    test('maintenance loglevel', () => {
        const {client, adapter, lines} = setup();
        client.emit('connect');
        client.deliver('foo/maintenance/set/loglevel', 'warn');
        assert.equal(adapter.log.getLevel(), 'warn');
        client.deliver('foo/maintenance/set/loglevel', 'silly');
        assert.ok(lines.some((l) => l.includes('unknown log level')));
    });
});

describe('shutdown', () => {
    test('publishes connected 0, calls onShutdown, ends mqtt, exits 0', async () => {
        let disconnected = false;
        const {client, adapter} = setup({onShutdown: () => (disconnected = true)});
        client.emit('connect');
        const realExit = process.exit;
        const exited = new Promise((resolve) => {
            process.exit = (code) => {
                process.exit = realExit;
                resolve(code);
            };
        });
        adapter.shutdown('SIGTERM');
        assert.equal(await exited, 0);
        assert.equal(disconnected, true);
        assert.equal(client.last('foo/connected').payload, '0');
        assert.equal(client.ended, true);
        assert.equal(adapter.shuttingDown, true);
    });

    test('maintenance restart triggers shutdown', async () => {
        const {client} = setup();
        client.emit('connect');
        const realExit = process.exit;
        const exited = new Promise((resolve) => {
            process.exit = (code) => {
                process.exit = realExit;
                resolve(code);
            };
        });
        client.deliver('foo/maintenance/set/restart', '1');
        assert.equal(await exited, 0);
        assert.equal(client.last('foo/connected').payload, '0');
    });
});
