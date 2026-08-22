import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {discoveryId, discoveryTopic, availability, entity, devicePayload} from '../lib/hadiscovery.js';

const pkg = {name: 'foo2mqtt', version: '1.0.0', homepage: 'https://github.com/x/foo2mqtt'};

describe('ids and topics', () => {
    test('sanitised id, topic with prefix', () => {
        assert.equal(discoveryId('foo2mqtt', 'tv living'), 'foo2mqtt_tv_living');
        assert.equal(discoveryTopic('ha', 'foo2mqtt_x'), 'ha/device/foo2mqtt_x/config');
    });
    test('availability template from connected', () => {
        const a = availability('foo');
        assert.equal(a[0].t, 'foo/connected');
        assert.match(a[0].avty_tpl, />= 2/);
        assert.match(availability('foo', 1)[0].avty_tpl, />= 1/);
    });
});

describe('entity', () => {
    const base = {id: 'foo2mqtt_foo', name: 'foo'};
    test('stateful entity with command', () => {
        const e = entity({
            ...base,
            item: 'volume',
            platform: 'number',
            label: 'Volume',
            icon: 'mdi:volume-high',
            command: true,
            extra: {min: 0, max: 100},
        });
        assert.deepEqual(e, {
            p: 'number',
            uniq_id: 'foo2mqtt_foo_volume',
            name: 'Volume',
            stat_t: 'foo/status/volume',
            val_tpl: '{{ value_json.val }}',
            cmd_t: 'foo/set/volume',
            ic: 'mdi:volume-high',
            min: 0,
            max: 100,
        });
    });
    test('json payloads (default) add a value template, plain payloads none, extra can override it', () => {
        const e = entity({...base, item: 'mute', platform: 'switch', label: 'Mute', jsonPayloads: true});
        assert.equal(e.val_tpl, '{{ value_json.val }}');
        const plain = entity({...base, item: 'mute', platform: 'switch', label: 'Mute', jsonPayloads: false});
        assert.equal(plain.val_tpl, undefined);
        const e2 = entity({
            ...base,
            item: 'mute',
            platform: 'switch',
            label: 'M',
            jsonPayloads: true,
            extra: {val_tpl: 'x'},
        });
        assert.equal(e2.val_tpl, 'x');
    });
    test('stateless platforms have no state topic, category and uid override', () => {
        const e = entity({
            ...base,
            item: 'button',
            uid: 'button_home',
            platform: 'button',
            label: 'HOME',
            category: 'diagnostic',
            command: true,
            jsonPayloads: true,
            extra: {pl_prs: 'HOME'},
        });
        assert.equal(e.stat_t, undefined);
        assert.equal(e.val_tpl, undefined);
        assert.equal(e.uniq_id, 'foo2mqtt_foo_button_home');
        assert.equal(e.cmd_t, 'foo/set/button');
        assert.equal(e.ent_cat, 'diagnostic');
        assert.equal(e.pl_prs, 'HOME');
    });
});

describe('devicePayload', () => {
    test('device, origin, availability, components', () => {
        const {topic, payload} = devicePayload({
            pkg,
            name: 'foo',
            device: {mf: 'ACME', mdl: 'X1'},
            components: {a: {p: 'sensor'}},
        });
        assert.equal(topic, 'homeassistant/device/foo2mqtt_foo/config');
        assert.deepEqual(payload.dev, {ids: ['foo2mqtt_foo'], name: 'foo', mf: 'ACME', mdl: 'X1'});
        assert.deepEqual(payload.o, {name: 'foo2mqtt', sw: '1.0.0', url: pkg.homepage});
        assert.equal(payload.avty[0].t, 'foo/connected');
        assert.equal(payload.qos, 0);
        assert.deepEqual(payload.cmps, {a: {p: 'sensor'}});
    });
    test('custom id and prefix', () => {
        const {topic, payload} = devicePayload({pkg, name: 'foo', prefix: 'ha', id: 'foo2mqtt_uuid1', components: {}});
        assert.equal(topic, 'ha/device/foo2mqtt_uuid1/config');
        assert.deepEqual(payload.dev.ids, ['foo2mqtt_uuid1']);
    });
});

describe('per-device availability (bridges)', () => {
    const components = {v: entity({id: 'foo2mqtt_x', name: 'foo', item: 'x/volume', platform: 'number', label: 'V'})};

    test('availability replaces the default and adds avty_mode all', () => {
        const avty = [
            ...availability('foo'),
            {t: 'foo/status/kitchen/connected', avty_tpl: "{{ 'online' if value_json.val else 'offline' }}"},
        ];
        const {payload} = devicePayload({pkg, name: 'foo', id: 'foo2mqtt_G090', components, availability: avty});
        assert.deepEqual(payload.avty, avty);
        assert.equal(payload.avty_mode, 'all');
    });

    test('a single entry needs no mode, an explicit mode wins', () => {
        const one = devicePayload({pkg, name: 'foo', components, availability: availability('foo', 1)});
        assert.equal(one.payload.avty_mode, undefined);
        assert.match(one.payload.avty[0].avty_tpl, />= 1/);
        const forced = devicePayload({pkg, name: 'foo', components, availabilityMode: 'any'});
        assert.equal(forced.payload.avty_mode, 'any');
    });

    test('without availability the default from connected is used', () => {
        const {payload} = devicePayload({pkg, name: 'foo', components, availability: []});
        assert.deepEqual(payload.avty, availability('foo'));
        assert.equal(payload.avty_mode, undefined);
    });
});
