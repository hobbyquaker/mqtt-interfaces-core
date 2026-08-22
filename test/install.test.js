import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {createInstaller, envVarName, instanceName} from '../lib/install.js';

const installer = createInstaller({
    service: 'foo2mqtt',
    envPrefix: 'FOO2MQTT',
    description: 'foo2mqtt %i - Foo to MQTT bridge',
    documentation: 'https://github.com/x/foo2mqtt',
    environment: {FOO_KEY_DIR: '%S/foo2mqtt/%i'},
    serviceExtra: ['SupplementaryGroups=dialout'],
});

describe('envFile', () => {
    test('writes only set options as FOO2MQTT_* variables, never the name nor meta options', () => {
        const argv = {
            name: 'foo',
            address: '192.168.1.20',
            pollInterval: undefined,
            jsonPayloads: true,
            haDiscovery: false,
            haPrefix: 'homeassistant',
            mqttUrl: 'mqtt://broker',
            mqttUsername: undefined,
            mqttPassword: null,
            verbosity: 'info',
            install: true,
        };
        Object.defineProperty(argv, '$options', {
            value: {
                address: {},
                'poll-interval': {},
                'json-payloads': {},
                'ha-discovery': {},
                'ha-prefix': {},
                'mqtt-url': {},
                'mqtt-username': {},
                'mqtt-password': {},
                verbosity: {},
                name: {},
                install: {},
                uninstall: {},
                'config-schema': {},
            },
        });
        const out = installer.envFile(argv);
        assert.match(out, /^FOO2MQTT_ADDRESS=192\.168\.1\.20$/m);
        assert.match(out, /^FOO2MQTT_MQTT_URL=mqtt:\/\/broker$/m);
        assert.match(out, /^FOO2MQTT_JSON_PAYLOADS=true$/m);
        assert.match(out, /^FOO2MQTT_HA_DISCOVERY=false$/m);
        assert.doesNotMatch(out, /^FOO2MQTT_(NAME|MQTT_USERNAME|MQTT_PASSWORD|POLL_INTERVAL|INSTALL)=/m);
        assert.match(out, /foo2mqtt@foo\.service/);
        assert.match(out, /broker\.env/);
    });

    test('explicit envOptions list', () => {
        const i = createInstaller({service: 's', envPrefix: 'S', envOptions: ['address']});
        const out = i.envFile({name: 'n', address: 'a', other: 'b'});
        assert.match(out, /^S_ADDRESS=a$/m);
        assert.doesNotMatch(out, /OTHER/);
    });
});

describe('unitFile', () => {
    test('is a template unit with shared broker env, per-instance env file, name and extra environment', () => {
        const unit = installer.unitFile('/usr/bin/node /usr/local/lib/node_modules/foo2mqtt/index.js');
        assert.match(unit, /^Description=foo2mqtt %i - Foo to MQTT bridge$/m);
        assert.match(unit, /^Documentation=https:\/\/github.com\/x\/foo2mqtt$/m);
        assert.match(unit, /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/node_modules\/foo2mqtt\/index\.js$/m);
        assert.match(unit, /^EnvironmentFile=-\/etc\/mqtt-interfaces\/broker\.env$/m);
        assert.match(unit, /^EnvironmentFile=\/etc\/foo2mqtt\/%i\.env$/m);
        assert.match(unit, /^Environment=FOO2MQTT_NAME=%i$/m);
        assert.match(unit, /^Environment=FOO_KEY_DIR=%S\/foo2mqtt\/%i$/m);
        assert.match(unit, /^SupplementaryGroups=dialout$/m);
        assert.match(unit, /^StateDirectory=foo2mqtt\/%i$/m);
        assert.match(unit, /^User=foo2mqtt$/m);
        assert.match(unit, /^SyslogIdentifier=foo2mqtt@%i$/m);
        assert.match(unit, /^SyslogLevelPrefix=true$/m);
        assert.match(unit, /^Restart=always$/m);
        assert.match(unit, /^WantedBy=multi-user\.target$/m);
        // the shared broker file must come first so the instance file can override it
        assert.ok(unit.indexOf('broker.env') < unit.indexOf('/etc/foo2mqtt/%i.env'));
    });
});

describe('helpers', () => {
    test('envVarName maps camelCase options', () => {
        assert.equal(envVarName('tv', 'LGTV2MQTT'), 'LGTV2MQTT_TV');
        assert.equal(envVarName('mqttUrl', 'LGTV2MQTT'), 'LGTV2MQTT_MQTT_URL');
        assert.equal(envVarName('haDiscovery', 'LGTV2MQTT'), 'LGTV2MQTT_HA_DISCOVERY');
    });

    test('instanceName rejects names systemd or the topic scheme cannot take', () => {
        assert.equal(instanceName('lgtv'), 'lgtv');
        assert.equal(instanceName('tv-living_room.1'), 'tv-living_room.1');
        assert.throws(() => instanceName('living room'));
        assert.throws(() => instanceName('a/b'));
        assert.throws(() => instanceName(''));
    });

    test('handle returns false without --install/--uninstall', () => {
        assert.equal(installer.handle({name: 'x'}), false);
    });
});
