import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {parseConfig, configSchema, applySharedEnv, envVarName} from '../lib/config.js';
import {discoveryNeeds} from '../lib/discovery.js';

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

    test('--uninstall does not require the mandatory adapter options', () => {
        const c = parse(['--uninstall', '-n', 'bar']);
        assert.equal(c.uninstall, true);
        assert.equal(c.name, 'bar');
        assert.equal(c.address, undefined);
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
        assert.equal(s['x-adapter'].mqttInterfaces, undefined);
        assert.equal(s.$id, 'https://github.com/x/foo2mqtt/config.schema.json');
    });

    test('x-secret for secret options, shared mqtt-password included', () => {
        const s = configSchema({
            pkg,
            envPrefix: 'FOO2MQTT',
            options: {...options, token: {type: 'string', describe: 'api token', secret: true}},
            defaults: {},
        });
        assert.equal(s.properties.token['x-secret'], true);
        assert.equal(s.properties['mqtt-password']['x-secret'], true);
        assert.equal(s.properties.address['x-secret'], undefined);
        assert.equal(s.properties['mqtt-url']['x-secret'], undefined);
    });

    test('x-file for options that hold a user-maintained file', () => {
        const s = configSchema({
            pkg,
            envPrefix: 'FOO2MQTT',
            options: {
                ...options,
                'map-file': {
                    type: 'string',
                    describe: 'names',
                    file: {format: 'json', example: 'example-map.json', schema: 'map.schema.json'},
                },
                'key-file': {type: 'string', file: {format: 'nope', describe: 'pairing key'}},
            },
            defaults: {},
        });
        assert.deepEqual(s.properties['map-file']['x-file'], {
            format: 'json',
            example: 'example-map.json',
            schema: 'map.schema.json',
        });
        assert.deepEqual(s.properties['key-file']['x-file'], {format: 'text', describe: 'pairing key'});
        assert.equal(s.properties.address['x-file'], undefined);
        const c = parseConfig({
            pkg,
            options: {...options, 'map-file': {type: 'string', file: {format: 'json'}}},
            defaults: {name: 'foo'},
            argv: ['-a', 'x', '--map-file', 'm.json'],
            env: {},
            exit: () => {},
            print: () => {},
        });
        assert.equal(c.mapFile, 'm.json');
    });

    test('x-adapter carries the package mqttInterfaces field', () => {
        const meta = {spec: '2.0', envPrefix: 'FOO2MQTT', needs: ['serial']};
        const s = configSchema({pkg: {...pkg, mqttInterfaces: meta}, envPrefix: 'FOO2MQTT', options, defaults: {}});
        assert.deepEqual(s['x-adapter'].mqttInterfaces, meta);
    });

    test('secret options parse like any other option', () => {
        const c = parseConfig({
            pkg,
            options: {...options, token: {type: 'string', describe: 'api token', secret: true}},
            defaults: {name: 'foo'},
            argv: ['-a', 'x', '--token', 't1'],
            env: {FOO2MQTT_MQTT_PASSWORD: 'pw'},
            exit: () => {},
            print: () => {},
        });
        assert.equal(c.token, 't1');
        assert.equal(c.mqttPassword, 'pw');
        assert.equal(c.$options.token.secret, true);
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

describe('discovery options', () => {
    test('are absent unless the adapter declares a hint', () => {
        const c = parse(['-a', '10.0.0.1']);
        assert.equal(c.discover, undefined);
        assert.equal(c.discoverTimeout, undefined);
    });

    test('discovery: true adds --discover, --discover-json and --discover-timeout', () => {
        const c = parseConfig({
            pkg,
            options,
            defaults: {name: 'foo'},
            discovery: true,
            argv: ['--discover'],
            env: {},
            exit: () => {},
            print: () => {},
        });
        assert.equal(c.discover, true);
        assert.equal(c.discoverTimeout, 5);
    });

    test('--discover is not blocked by a mandatory adapter option', () => {
        // `address` is demandOption — going looking for it is the whole point of --discover
        const c = parseConfig({
            pkg,
            options,
            defaults: {name: 'foo'},
            discovery: true,
            argv: ['--discover'],
            env: {},
            exit: () => {},
            print: () => {},
        });
        assert.equal(c.address, undefined);
        assert.equal(c.discover, true);
    });

    test('but hint.needs keeps demanding what the scan itself consumes', () => {
        /*
         * A cloud hint cannot list an account without its credentials, so --email stays mandatory
         * under --discover while `address` — the option the scan fills — stays exempt. The
         * refusal itself is yargs': it prints the usage and exits the process, which a test
         * cannot intercept through parseConfig's `exit`, so what is asserted here is that the
         * option keeps demanding and that the exemption still applies to everything else.
         */
        const withSecret = {...options, email: {type: 'string', describe: 'account', demandOption: true}};
        const c = parseConfig({
            pkg,
            options: withSecret,
            defaults: {name: 'foo'},
            discovery: {cloud: {list: () => []}, needs: ['email']},
            argv: ['--discover', '--email', 'me@example.com'],
            env: {},
            exit: () => {},
            print: () => {},
        });
        assert.equal(c.email, 'me@example.com');
        assert.equal(c.address, undefined, 'the option the scan fills is still exempt');
    });

    test('discoveryNeeds: only a hint that names them, and only strings', () => {
        assert.deepEqual(discoveryNeeds({cloud: {}, needs: ['email', 'password']}), ['email', 'password']);
        assert.deepEqual(discoveryNeeds({ssdp: {}}), [], 'a network hint needs nothing to scan');
        assert.deepEqual(discoveryNeeds(true), []);
        assert.deepEqual(discoveryNeeds(undefined), []);
        assert.deepEqual(discoveryNeeds({needs: ['ok', '', null, 7]}), ['ok']);
    });

    test('x-discover marks the property the scan fills, with the kind of scan', () => {
        const withHint = {...options, address: {...options.address, discover: true}};
        const network = configSchema({
            pkg,
            envPrefix: 'FOO2MQTT',
            options: withHint,
            defaults: {name: 'foo'},
            discovery: {ssdp: {st: 'x'}, ports: {api: 80}},
        });
        assert.equal(network.properties.address['x-discover'], 'network');
        assert.equal(network.properties['poll-interval']['x-discover'], undefined);

        const serial = configSchema({
            pkg,
            envPrefix: 'FOO2MQTT',
            options: withHint,
            defaults: {name: 'foo'},
            discovery: {serial: {contains: ['busware']}},
        });
        assert.equal(serial.properties.address['x-discover'], 'serial');

        const both = configSchema({
            pkg,
            envPrefix: 'FOO2MQTT',
            options: withHint,
            defaults: {name: 'foo'},
            discovery: {serial: {}, udp: {port: 1}},
        });
        assert.deepEqual(both.properties.address['x-discover'], ['network', 'serial']);

        const cloud = configSchema({
            pkg,
            envPrefix: 'FOO2MQTT',
            options: withHint,
            defaults: {name: 'foo'},
            discovery: {cloud: {list: () => []}, needs: ['email']},
        });
        assert.equal(cloud.properties.address['x-discover'], 'cloud');
    });

    test('no hint, no marker — an adapter without discovery is not discovery-capable', () => {
        const schema = configSchema({
            pkg,
            envPrefix: 'FOO2MQTT',
            options: {...options, address: {...options.address, discover: true}},
            defaults: {name: 'foo'},
        });
        assert.equal(schema.properties.address['x-discover'], undefined);
    });

    test('`discover: true` is metadata, not a yargs option', () => {
        const c = parseConfig({
            pkg,
            options: {...options, address: {...options.address, discover: true}},
            defaults: {name: 'foo'},
            discovery: {ssdp: {}},
            argv: ['-a', '10.0.0.1'],
            env: {},
            exit: () => {},
            print: () => {},
        });
        assert.equal(c.address, '10.0.0.1');
        assert.equal(c.discover, undefined, 'the value, not the flag');
    });

    test('they never reach the instance configuration', () => {
        const schema = configSchema({pkg, envPrefix: 'FOO2MQTT', options, defaults: {name: 'foo'}});
        for (const meta of ['discover', 'discover-json', 'discover-timeout', 'discover-address', 'discover-ip']) {
            assert.equal(schema.properties[meta], undefined, meta);
        }
    });
});
