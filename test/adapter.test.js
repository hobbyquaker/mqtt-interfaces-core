import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {createAdapter, matchTopic} from '../lib/adapter.js';
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
    deliver(topic, payload, packet = {}) {
        this.emit('message', topic, Buffer.from(String(payload)), packet);
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

    test('reconnect does not re-publish non-retained events', () => {
        const {client, adapter} = setup();
        client.emit('connect');
        adapter.pubStatus('volume', 7);
        adapter.pubStatus('last_voice_command', 'play swr3', {retain: false});
        assert.equal(client.last('foo/status/last_voice_command').options.retain, false);
        client.emit('close');
        const n = client.published.length;
        client.emit('connect');
        const after = client.published.slice(n);
        assert.ok(after.some((m) => m.topic === 'foo/status/volume'));
        assert.equal(
            after.some((m) => m.topic === 'foo/status/last_voice_command'),
            false,
        );
    });

    test('clearStatus forgets an item and clears its retained payload', () => {
        const {client, adapter} = setup();
        client.emit('connect');
        adapter.pubStatus('kitchen/volume', 7);
        assert.equal(adapter.clearStatus('kitchen/volume'), true);
        assert.equal(client.last('foo/status/kitchen/volume').payload, '');
        assert.equal(client.last('foo/status/kitchen/volume').options.retain, true);
        assert.equal(adapter.get('kitchen/volume'), undefined);
        assert.equal(adapter.clearStatus('kitchen/volume'), false);
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

    test('discovery triggers are coalesced into one re-publish, --no-ha-discovery clears', async () => {
        const {client, adapter} = setup({discoveryDelay: 10});
        client.emit('connect');
        client.published.length = 0;
        adapter.pubStatus('volume', 1);
        adapter.pubStatus('model', 'X1');
        adapter.pubStatus('model', 'X2');
        const topic = 'homeassistant/device/foo2mqtt_foo/config';
        assert.equal(client.last(topic), undefined);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const hits = client.published.filter((p) => p.topic === topic);
        assert.equal(hits.length, 1);
        assert.equal(JSON.parse(hits[0].payload).dev.mdl, 'X2');

        const off = setup({}, {haDiscovery: false});
        off.client.emit('connect');
        assert.equal(off.client.last('homeassistant/device/foo2mqtt_foo/config').payload, '');
    });

    test('discovery may return several devices; vanished ones are cleared', () => {
        let devices = ['a', 'b'];
        const {client, adapter} = setup({
            discovery: () => [
                {device: {mf: 'ACME'}, components: {}},
                ...devices.map((d) => ({
                    id: `foo2mqtt_foo_${d}`,
                    device: {name: d, via_device: 'foo2mqtt_foo'},
                    components: {
                        t: entity({
                            id: `foo2mqtt_foo_${d}`,
                            name: 'foo',
                            item: `${d}/t`,
                            platform: 'sensor',
                            label: 't',
                        }),
                    },
                })),
            ],
        });
        client.emit('connect');
        const bridge = JSON.parse(client.last('homeassistant/device/foo2mqtt_foo/config').payload);
        assert.deepEqual(bridge.dev, {ids: ['foo2mqtt_foo'], name: 'foo', mf: 'ACME'});
        const a = JSON.parse(client.last('homeassistant/device/foo2mqtt_foo_a/config').payload);
        assert.deepEqual(a.dev, {ids: ['foo2mqtt_foo_a'], name: 'a', via_device: 'foo2mqtt_foo'});
        assert.equal(a.cmps.t.stat_t, 'foo/status/a/t');
        assert.ok(client.last('homeassistant/device/foo2mqtt_foo_b/config').payload.length > 0);

        devices = ['a'];
        client.published.length = 0;
        adapter.markDiscoveryDirty();
        adapter.publishDiscovery();
        assert.equal(client.last('homeassistant/device/foo2mqtt_foo_b/config').payload, '');
        assert.ok(client.last('homeassistant/device/foo2mqtt_foo_a/config').payload.length > 0);

        // --no-ha-discovery at runtime clears everything that was announced
        adapter.config.haDiscovery = false;
        client.published.length = 0;
        adapter.publishDiscovery();
        assert.equal(client.last('homeassistant/device/foo2mqtt_foo/config').payload, '');
        assert.equal(client.last('homeassistant/device/foo2mqtt_foo_a/config').payload, '');
    });
});

describe('stats (0.8.0)', () => {
    test('statsPayload carries memory, cpu share and uptime; publishStats retains it under maintenance/stats', () => {
        const {adapter, client} = setup({}, {statsInterval: 0});
        client.emit('connect');
        const s = adapter.statsPayload();
        assert.ok(s.rss > 0 && s.heapUsed > 0 && s.heapTotal >= s.heapUsed);
        assert.ok(typeof s.cpu === 'number' && s.cpu >= 0);
        assert.equal(typeof s.eventLoopLag, 'number');
        assert.ok(s.uptime >= 0 && s.ts > 0);
        adapter.publishStats();
        const m = client.last('foo/maintenance/stats');
        assert.ok(m, 'published');
        assert.equal(m.options.retain, true);
        assert.deepEqual(Object.keys(JSON.parse(m.payload)).sort(), [
            'cpu',
            'eventLoopLag',
            'heapTotal',
            'heapUsed',
            'rss',
            'ts',
            'uptime',
        ]);
        adapter.shutdown('test');
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

describe('subscriptions (0.7.0)', () => {
    test('matchTopic', () => {
        assert.deepEqual(matchTopic('paramset/#', ['paramset', 'Foo', 'MASTER']), ['Foo', 'MASTER']);
        assert.equal(matchTopic('paramset/#', ['paramset']), null);
        assert.equal(matchTopic('paramset/#', ['set', 'x']), null);
        assert.deepEqual(matchTopic('rpc/+/+/+', ['rpc', 'BidCos-RF', 'getValue', 'id1']), [
            'BidCos-RF',
            'getValue',
            'id1',
        ]);
        assert.equal(matchTopic('rpc/+/+/+', ['rpc', 'BidCos-RF', 'getValue']), null);
        assert.equal(matchTopic('rpc/+/+/+', ['rpc', 'a', 'b', 'c', 'd']), null);
        assert.deepEqual(matchTopic('+/get', ['volume', 'get']), ['volume']);
        assert.deepEqual(matchTopic('sync', ['sync']), []);
        assert.equal(matchTopic('#/x', ['a', 'x']), null);
    });

    test('extra topics are subscribed and dispatched with the captured levels', async () => {
        const calls = [];
        const {client, lines, sets} = setup({
            subscriptions: {
                'paramset/#': (parts, value, topic, raw) => {
                    calls.push({parts, value, topic, raw});
                    if (value === 'boom') {
                        throw new Error('kaboom');
                    }
                },
                'rpc/+/+/+': (parts) => calls.push({rpc: parts}),
            },
        });
        client.emit('connect');
        assert.deepEqual(client.subscribed, ['foo/set/#', 'foo/maintenance/set/+', 'foo/paramset/#', 'foo/rpc/+/+/+']);
        client.deliver('foo/paramset/Licht Flur/MASTER', '{"ON_TIME": 5}');
        client.deliver('foo/rpc/BidCos-RF/getValue/c1', '["ABC:1", "STATE"]');
        client.deliver('foo/paramset', '1');
        client.deliver('foo/set/volume', '3');
        client.deliver('foo/paramset/x/y', 'boom');
        assert.deepEqual(calls[0], {
            parts: ['Licht Flur', 'MASTER'],
            value: {ON_TIME: 5},
            topic: 'foo/paramset/Licht Flur/MASTER',
            raw: '{"ON_TIME": 5}',
        });
        assert.deepEqual(calls[1], {rpc: ['BidCos-RF', 'getValue', 'c1']});
        assert.equal(calls.length, 3);
        assert.deepEqual(sets[0].parts, ['volume']);
        assert.equal(lines.filter((l) => l.includes('ignoring unexpected topic')).length, 1);
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(lines.some((l) => l.includes('<4>dev paramset x/y failed: kaboom')));
    });

    test('listen: a sink gets topics anywhere on the broker, with the packet', async () => {
        const seen = [];
        const {client, lines} = setup({
            listen: {
                '+/status/#': (topic, value, raw, packet) => {
                    seen.push({topic, value, raw, retain: Boolean(packet.retain)});
                    if (raw === 'boom') {
                        throw new Error('kaboom');
                    }
                },
                '$SYS/#': (topic) => seen.push({sys: topic}),
            },
        });
        client.emit('connect');
        assert.deepEqual(
            client.subscribed,
            ['foo/set/#', 'foo/maintenance/set/+', '+/status/#', '$SYS/#'],
            "the sink patterns are absolute, the adapter's own are prefixed",
        );

        client.deliver('hm/status/Licht', '{"val": 21.5}');
        client.deliver('$SYS/broker/uptime', '1000');
        client.deliver('zigbee2mqtt/x', '1'); // matches nothing
        assert.deepEqual(seen[0], {topic: 'hm/status/Licht', value: 21.5, raw: '{"val": 21.5}', retain: false});
        assert.deepEqual(seen[1], {sys: '$SYS/broker/uptime'});
        assert.equal(seen.length, 2);
        assert.equal(lines.filter((l) => l.includes('ignoring unexpected topic')).length, 1);

        // retain is what tells a sink live traffic from the broker replaying its backlog
        client.deliver('hm/status/Licht', '1', {retain: true});
        assert.equal(seen[2].retain, true);

        // a throwing handler is logged, not fatal
        client.deliver('hm/status/Licht', 'boom');
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(lines.some((l) => l.includes('hm/status/Licht failed: kaboom')));
    });

    test("listen: the adapter's own set and maintenance win over a matching sink pattern", () => {
        const seen = [];
        const {client, sets} = setup({listen: {'+/+/#': (topic) => seen.push(topic)}});
        client.emit('connect');
        client.deliver('foo/set/volume', '3');
        client.deliver('foo/maintenance/set/loglevel', 'debug');
        assert.deepEqual(sets[0].parts, ['volume'], 'set was acted on, not forwarded');
        assert.deepEqual(seen, [], 'neither reached the sink');
        // but the adapter's own status topics do reach it — they are ordinary traffic
        client.deliver('foo/status/volume', '3');
        assert.deepEqual(seen, ['foo/status/volume']);
    });

    test('extra payload fields and device-side timestamps survive a reconnect', () => {
        const {client, adapter} = setup({}, {jsonPayloads: true});
        client.emit('connect');
        adapter.pubStatus('Licht/STATE', true, {extra: {hm: {channel: 'ABC:1'}, val: 'ignored'}, ts: 1000, lc: 900});
        let p = JSON.parse(client.last('foo/status/Licht/STATE').payload);
        assert.deepEqual(p, {val: true, ts: 1000, lc: 900, hm: {channel: 'ABC:1'}});
        assert.equal(adapter.get('Licht/STATE'), true);
        client.emit('close');
        client.published.length = 0;
        client.emit('connect');
        p = JSON.parse(client.last('foo/status/Licht/STATE').payload);
        assert.deepEqual(p, {val: true, ts: 1000, lc: 900, hm: {channel: 'ABC:1'}});

        // plain payloads ignore extra
        const plain = setup();
        plain.client.emit('connect');
        plain.adapter.pubStatus('x', 1, {extra: {hm: {}}});
        assert.equal(plain.client.last('foo/status/x').payload, '1');
    });
});
