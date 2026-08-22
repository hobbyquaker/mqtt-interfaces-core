/**
 * The adapter façade: owns the MQTT connection and everything mqtt-smarthome prescribes around it,
 * so an adapter is left with its device protocol and an item table.
 *
 *   <name>/connected                0 (LWT / shutdown), 1 (mqtt only), 2 (mqtt + device)
 *   <name>/status/<item>            retained; {val, ts, lc} JSON, or plain with --no-json-payloads
 *   <name>/set/<item>[/...]         → onSet(parts, value, topic); plain and {val} payloads
 *   <name>/info                     retained JSON about the running instance
 *   <name>/maintenance/set/loglevel  error|warn|info|debug (runtime)
 *   <name>/maintenance/set/restart   graceful shutdown + exit 0 (the supervisor restarts us)
 *   <prefix>/device/<id>/config     Home Assistant discovery (--ha-discovery, on by default)
 */

import os from 'node:os';
import fs from 'node:fs';
import mqttLib from 'mqtt';
import {createLogger, LEVELS} from './log.js';
import {parsePayload, StatusTracker} from './payload.js';
import {devicePayload, discoveryId} from './hadiscovery.js';

const SPEC_VERSION = '2.0';

/**
 * @param {object} a
 * @param {{name: string, version: string, homepage?: string}} a.pkg adapter package.json
 * @param {object} a.config parsed config (parseConfig): name, mqttUrl, mqttUsername, mqttPassword,
 *        mqttClientIdPrefix, mqttTlsCa, jsonPayloads, haDiscovery, haPrefix, maintenance, verbosity
 * @param {object} [a.log] logger (default createLogger with the config's env prefix and verbosity)
 * @param {string} [a.deviceLabel] how the device is called in log lines (default "device")
 * @param {object | (() => object)} [a.info] extra fields for <name>/info (e.g. {tv: '192.168.1.20'})
 * @param {(ctx: {get: Function, config: object}) => DiscoveryDevice | DiscoveryDevice[] | null} [a.discovery]
 *        builds the HA device block(s) + entity maps from the last known status values. One
 *        device ({id?, device?, components, availabilityMin?}) or an array of them when the adapter
 *        bridges several devices (give each its own `id`; `device.via_device` links them to the
 *        bridge). Devices missing from a later result get their retained announcement cleared.
 * @param {string[]} [a.discoveryTriggers] status items whose change re-publishes discovery
 * @param {number} [a.discoveryDelay] ms to coalesce trigger-driven re-publishes (default 1000)
 * @param {(parts: string[], value: *, topic: string, raw: string) => Promise<void> | void} [a.onSet]
 *        handles <name>/set/<parts...>; throw/reject to have the failure logged at warn
 * @param {() => void} [a.onMqttConnect] after (re)connect, subscriptions done, status re-published
 * @param {() => Promise<void> | void} [a.onShutdown] disconnect the device
 * @param {() => Date | number} [a.now] for tests
 */
export function createAdapter({
    pkg,
    config,
    log,
    deviceLabel = 'device',
    info,
    discovery,
    discoveryTriggers = [],
    discoveryDelay = 1000,
    onSet,
    onMqttConnect,
    onShutdown,
    mqttConnect = mqttLib.connect,
}) {
    const envPrefix = config.$envPrefix || pkg.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    log = log || createLogger({envPrefix, level: config.verbosity});

    const name = config.name;
    const topic = (...parts) => [name, ...parts].join('/');
    const connectedTopic = topic('connected');
    const status = new StatusTracker({json: config.jsonPayloads});
    const triggers = new Set(discoveryTriggers);
    const startedAt = new Date();

    let mqtt = null;
    let mqttConnected = false;
    let deviceConnected = false;
    let shuttingDown = false;
    let discoveryDirty = true;
    let discoveryTimer = null;
    let lastDiscoveryTopics = new Set();

    /*
     * publishing
     */

    function publish(t, payload, options = {}) {
        if (!mqtt) {
            return;
        }
        if (payload !== null && typeof payload === 'object') {
            payload = JSON.stringify(payload);
        }
        payload = payload === undefined || payload === null ? '' : String(payload);
        log.debug('mqtt >', t, payload);
        mqtt.publish(t, payload, options);
    }

    function publishConnected() {
        if (mqttConnected) {
            publish(connectedTopic, deviceConnected ? '2' : '1', {retain: true});
        }
    }

    /** Publish a status item (retained by default); tracks last values for discovery / json payloads. */
    function pubStatus(item, value, {retain = true} = {}) {
        const {payload, changed} = status.update(item, value);
        if (mqttConnected) {
            publish(topic('status', item), payload, {retain});
        }
        if (changed && triggers.has(item)) {
            discoveryDirty = true;
            scheduleDiscovery();
        }
        return changed;
    }

    /** Coalesce trigger-driven discovery re-publishes (device info usually arrives item by item). */
    function scheduleDiscovery() {
        if (discoveryTimer) {
            return;
        }
        discoveryTimer = setTimeout(() => {
            discoveryTimer = null;
            publishDiscovery();
        }, discoveryDelay);
        if (typeof discoveryTimer.unref === 'function') {
            discoveryTimer.unref();
        }
    }

    /** Re-publish every known status (after an mqtt reconnect). */
    function republishStatus() {
        for (const item of status.state.keys()) {
            publish(topic('status', item), status.payload(item), {retain: true});
        }
    }

    function infoPayload() {
        const extra = typeof info === 'function' ? info() : info;
        return {
            name: pkg.name,
            version: pkg.version,
            spec: SPEC_VERSION,
            node: process.version,
            host: os.hostname(),
            pid: process.pid,
            started: startedAt.toISOString(),
            maintenance: Boolean(config.maintenance),
            ...extra,
        };
    }

    function publishInfo() {
        if (mqttConnected) {
            publish(topic('info'), infoPayload(), {retain: true});
        }
    }

    /**
     * Build the discovery messages: one per device. `discovery()` returns one device block or an
     * array of them (a bridge with several devices behind it, e.g. RF sensors seen by a CUL).
     * @returns {Array<{topic: string, payload: object}>}
     */
    function buildDiscovery() {
        if (!discovery) {
            return [];
        }
        const built = discovery({get: (item) => status.get(item), config});
        if (!built) {
            return [];
        }
        const devices = Array.isArray(built) ? built : [built];
        return devices.filter(Boolean).map(({id, device, components, availabilityMin}) =>
            devicePayload({
                pkg,
                name,
                prefix: config.haPrefix,
                id: id || discoveryId(pkg.name, name),
                device,
                components,
                availabilityMin,
            }),
        );
    }

    /** Publish HA discovery if enabled and something changed (or force). */
    function publishDiscovery({force = false} = {}) {
        if (!discovery || !mqttConnected) {
            return;
        }
        if (!config.haDiscovery) {
            clearDiscovery();
            return;
        }
        if (!discoveryDirty && !force) {
            return;
        }
        if (discoveryTimer) {
            clearTimeout(discoveryTimer);
            discoveryTimer = null;
        }
        const built = buildDiscovery();
        if (built.length === 0) {
            return;
        }
        discoveryDirty = false;
        const topics = new Set(built.map((b) => b.topic));
        // devices that are gone (or a changed id) lose their retained announcement
        for (const t of lastDiscoveryTopics) {
            if (!topics.has(t)) {
                publish(t, '', {retain: true});
            }
        }
        lastDiscoveryTopics = topics;
        log.info(
            'mqtt publishing home assistant discovery',
            built.length === 1 ? built[0].topic : `${built.length} devices`,
        );
        for (const {topic: t, payload} of built) {
            publish(t, payload, {retain: true});
        }
    }

    function clearDiscovery() {
        const topics = new Set([...lastDiscoveryTopics, ...buildDiscovery().map((b) => b.topic)]);
        lastDiscoveryTopics = new Set();
        for (const t of topics) {
            publish(t, '', {retain: true});
        }
    }

    /*
     * incoming
     */

    function handleMessage(t, raw) {
        raw = raw.toString();
        log.debug('mqtt <', t, raw);
        const [prefix, action, ...parts] = t.split('/');
        if (prefix !== name || parts.length < 1 || parts.includes('')) {
            log.warn('mqtt ignoring unexpected topic', t);
            return;
        }
        if (action === 'maintenance') {
            handleMaintenance(parts, raw);
            return;
        }
        if (action !== 'set') {
            log.warn('mqtt ignoring unexpected topic', t);
            return;
        }
        if (!onSet) {
            return;
        }
        const value = parsePayload(raw);
        const failed = (err) => {
            log.warn(deviceLabel, 'set', parts.join('/'), 'failed:', (err && err.message) || err);
        };
        try {
            Promise.resolve(onSet(parts, value, t, raw)).catch(failed);
        } catch (err) {
            failed(err);
        }
    }

    function handleMaintenance(parts, raw) {
        if (parts[0] !== 'set' || parts.length !== 2) {
            log.warn('mqtt ignoring unexpected maintenance topic', topic('maintenance', ...parts));
            return;
        }
        const value = parsePayload(raw);
        switch (parts[1]) {
            case 'loglevel': {
                const level = String(value).toLowerCase();
                if (!(level in LEVELS)) {
                    log.warn('maintenance: unknown log level', value);
                    return;
                }
                log.setLevel(level);
                log.warn('maintenance: log level set to', level);
                break;
            }
            case 'restart':
                log.warn('maintenance: restart requested via mqtt');
                shutdown('restart');
                break;
            default:
                log.warn('maintenance: unknown command', parts[1]);
        }
    }

    /*
     * lifecycle
     */

    function mqttOptions() {
        const rand = Math.random().toString(16).slice(2, 10);
        const opts = {
            clientId: `${config.mqttClientIdPrefix || ''}${name}_${rand}`,
            username: config.mqttUsername,
            password: config.mqttPassword,
            will: {topic: connectedTopic, payload: '0', retain: true},
        };
        if (config.mqttTlsCa) {
            opts.ca = fs.readFileSync(config.mqttTlsCa);
        }
        return opts;
    }

    function start() {
        log.info(pkg.name + ' ' + pkg.version + ' starting');
        log.info('mqtt trying to connect', config.mqttUrl);
        mqtt = mqttConnect(config.mqttUrl, mqttOptions());

        mqtt.on('connect', () => {
            const reconnect = mqttConnected;
            mqttConnected = true;
            log.info('mqtt connected', config.mqttUrl);
            publishConnected();
            publishInfo();

            const subs = [topic('set', '#')];
            if (config.maintenance) {
                subs.push(topic('maintenance', 'set', '+'));
            }
            log.info('mqtt subscribe', subs.join(', '));
            mqtt.subscribe(subs);

            discoveryDirty = true;
            publishDiscovery();
            if (reconnect || status.state.size > 0) {
                republishStatus();
            }
            if (onMqttConnect) {
                onMqttConnect({reconnect});
            }
        });

        mqtt.on('close', () => {
            if (mqttConnected) {
                mqttConnected = false;
                log.info('mqtt closed', config.mqttUrl);
            }
        });

        mqtt.on('error', (err) => {
            log.error('mqtt', err.message || err);
        });

        mqtt.on('message', handleMessage);

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        return adapter;
    }

    /** Device (dis)connected: publishes connected 2/1 and logs the transition. */
    function setDeviceConnected(connected) {
        connected = Boolean(connected);
        if (connected === deviceConnected) {
            return;
        }
        deviceConnected = connected;
        publishConnected();
    }

    function shutdown(reason = 'shutdown', exitCode = 0) {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        log.info('received', reason, '- shutting down');

        const exit = () => process.exit(exitCode);
        const timer = setTimeout(exit, 2000);
        const done = () => {
            clearTimeout(timer);
            exit();
        };

        Promise.resolve()
            .then(() => onShutdown && onShutdown())
            .catch((err) => log.debug(deviceLabel, 'disconnect', err.message || err))
            .then(() => {
                if (!mqtt) {
                    return done();
                }
                if (mqttConnected) {
                    mqtt.publish(connectedTopic, '0', {retain: true}, () => {
                        mqtt.end(false, {}, done);
                    });
                } else {
                    mqtt.end(true, {}, done);
                }
            });
    }

    const adapter = {
        pkg,
        config,
        log,
        name,
        status,
        topic,
        get: (item) => status.get(item),
        get mqtt() {
            return mqtt;
        },
        get mqttConnected() {
            return mqttConnected;
        },
        get deviceConnected() {
            return deviceConnected;
        },
        get shuttingDown() {
            return shuttingDown;
        },
        publish,
        pubStatus,
        republishStatus,
        publishInfo,
        infoPayload,
        publishDiscovery,
        markDiscoveryDirty: () => {
            discoveryDirty = true;
        },
        buildDiscovery,
        setDeviceConnected,
        start,
        shutdown,
    };
    return adapter;
}
