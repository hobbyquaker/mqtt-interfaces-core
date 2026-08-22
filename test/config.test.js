import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {parseConfig, configSchema, applySharedEnv, envVarName} from '../lib/config.js';

const pkg = {name: 'foo2mqtt', version: '1.2.3', homepage: 'https://github.com/x/foo2mqtt', description: 'Foo to MQTT'};
const options = {
    address: {alias: 'a', type: 'string', describe: 'device address', demandOption: true},
    'poll-interval': {type: 'number', describe: 'seconds', default: 30},
};

function parse(argv, env = {}) {
    return parseConfig({pkg, options, defaults: {name: 'foo'}, argv, env, exit: () => {}, print: () => {}});
}

describe('parseConfig', () => {
    test('shared and adapter options with defaults, camelCased', () => {
        const c = parse(['-a', '10.0.0.1']);
        assert.equal(c.address, '10.0.0.1');
        assert.equal(c.pollInterval, 30);
        assert.equal(c.name, 'foo');
        assert.equal(c.mqttUrl, 'mqtt://localhost');
        assert.equal(c.haDiscovery, true);
        assert.equal(c.maintenance, true);
        assert.equal(c.jsonPayloads, true);
        assert.equal(c.verbosity, 'info');
        assert.equal(c.$envPrefix, 'FOO2MQTT');
        assert.ok(c.$options.address);
    });

    test('aliases and negation', () => {
        const c = parse(['-a', 'x', '--url', 'mqtt://b', '--no-ha-discovery', '--no-maintenance', '-n', 'bar']);
        assert.equal(c.mqttUrl, 'mqtt://b');
        assert.equal(c.haDiscovery, false);
        assert.equal(c.maintenance, false);
        assert.equal(c.name, 'bar');
    });

    test('env vars with prefix, cli wins', () => {
        const env = {FOO2MQTT_ADDRESS: '1.1.1.1', FOO2MQTT_MQTT_URL: 'mqtt://env', FOO2MQTT_POLL_INTERVAL: '5'};
        const c = parse(['--mqtt-url', 'mqtt://cli'], env);
        assert.equal(c.address, '1.1.1.1');
        assert.equal(c.mqttUrl, 'mqtt://cli');
        assert.equal(c.pollInterval, 5);
    });

    test('unprefixed MQTT_* fallback', () => {
        const env = {FOO2MQTT_ADDRESS: 'x', MQTT_URL: 'mqtt://shared', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p'};
        const c = parse([], env);
        assert.equal(c.mqttUrl, 'mqtt://shared');
        assert.equal(c.mqttUsername, 'u');
        assert.equal(c.mqttPassword, 'p');
        const c2 = parse([], {FOO2MQTT_ADDRESS: 'x', MQTT_URL: 'mqtt://shared', FOO2MQTT_MQTT_URL: 'mqtt://own'});
        assert.equal(c2.mqttUrl, 'mqtt://own');
    });

    test('--config-schema prints and exits', () => {
        let printed;
        let code;
        parseConfig({
            pkg,
            options,
            argv: ['--config-schema'],
            env: {},
            exit: (c) => {
                code = c;
            },
            print: (s) => {
                printed = s;
            },
        });
        assert.equal(code, 0);
        const schema = JSON.parse(printed);
        assert.equal(schema.title, 'foo2mqtt');
        assert.ok(schema.properties.address);
    });
});

describe('configSchema', () => {
    test('properties for every instance option, none for the meta options', () => {
        const s = configSchema({pkg, envPrefix: 'FOO2MQTT', options, defaults: {name: 'foo'}});
        assert.equal(s.type, 'object');
        assert.deepEqual(s.properties.address, {
            type: 'string',
            description: 'device address',
            'x-env': 'FOO2MQTT_ADDRESS',
        });
        assert.deepEqual(s.properties['poll-interval'], {
            type: 'number',
            description: 'seconds',
            default: 30,
            'x-env': 'FOO2MQTT_POLL_INTERVAL',
        });
        assert.equal(s.properties.name.default, 'foo');
        assert.deepEqual(s.properties.verbosity.enum, ['error', 'warn', 'info', 'debug']);
        assert.equal(s.properties['mqtt-url']['x-env'], 'FOO2MQTT_MQTT_URL');
        assert.deepEqual(s.required, ['address']);
        for (const meta of ['install', 'uninstall', 'config-schema', 'help', 'version']) {
            assert.equal(s.properties[meta], undefined, meta);
        }
        assert.equal(s['x-adapter'].envPrefix, 'FOO2MQTT');
        assert.equal(s.$id, 'https://github.com/x/foo2mqtt/config.schema.json');
    });
});

describe('helpers', () => {
    test('envVarName', () => {
        assert.equal(envVarName('mqtt-url', 'X'), 'X_MQTT_URL');
        assert.equal(envVarName('mqttUrl', 'X'), 'X_MQTT_URL');
        assert.equal(envVarName('tv', 'LGTV2MQTT'), 'LGTV2MQTT_TV');
    });
    test('applySharedEnv does not override prefixed values', () => {
        const env = applySharedEnv({MQTT_URL: 'a', X_MQTT_URL: 'b', MQTT_TLS_CA: '/ca.pem'}, 'X');
        assert.equal(env.X_MQTT_URL, 'b');
        assert.equal(env.X_MQTT_TLS_CA, '/ca.pem');
    });
});
