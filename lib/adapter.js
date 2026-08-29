/**
 * The adapter façade: owns the MQTT connection and everything mqtt-smarthome prescribes around it,
 * so an adapter is left with its device protocol and an item table.
 *
 *   <name>/connected                0 (LWT / shutdown), 1 (mqtt only), 2 (mqtt + device)
 *   <name>/status/<item>            retained; {val, ts, lc} JSON, or plain with --no-json-payloads
 *   <name>/set/<item>[/...]         → onSet(parts, value, topic); plain and {val} payloads
 *   <name>/<pattern>                → subscriptions[pattern] handler (an adapter's own topics)
 *   <pattern> anywhere on the broker → listen[pattern] handler (a sink: influx4mqtt and the like)
 *   <name>/info                     retained JSON about the running instance
 *   <name>/maintenance/set/loglevel  error|warn|info|debug (runtime)
 *   <name>/maintenance/set/restart   graceful shutdown + exit 0 (the supervisor restarts us)
 *   <name>/maintenance/stats        retained, every --stats-interval seconds: rss, heapUsed, heapTotal, cpu (% of one core
 *                                    over the interval), eventLoopLag (ms), uptime (s), ts — for dashboards (she)
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
 * Matches topic levels against a subscription pattern (relative to <name>/). `+` captures one
 * level, a trailing `#` captures the rest (at least one level). Returns the captured levels, or
 * null when the topic does not match.
 * @param {string} pattern e.g. 'paramset/#', 'rpc/+/+/+'
 * @param {string[]} levels topic levels after <name>/
 * @returns {string[] | null}
 */
export function matchTopic(pattern, levels) {
    const p = pattern.split('/');
    const captured = [];
    for (let i = 0; i < p.length; i++) {
        if (p[i] === '#') {
            if (i !== p.length - 1 || levels.length <= i) {
                return null;
            }
            captured.push(...levels.slice(i));
            return captured;
        }
        if (i >= levels.length) {
            return null;
        }
        if (p[i] === '+') {
            captured.push(levels[i]);
        } else if (p[i] !== levels[i]) {
            return null;
        }
    }
    return levels.length === p.length ? captured : null;
}

/** The literal prefix of a pattern, for log lines ('paramset' for 'paramset/#'). */
function patternLabel(pattern) {
    const literal = [];
    for (const level of pattern.split('/')) {
        if (level === '+' || level === '#') {
            break;
        }
        literal.push(level);
    }
    return literal.length > 0 ? literal.join('/') : pattern;
}

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
 *        device ({id?, device?, components, availabilityMin?, availability?}) or an array of them
 *        when the adapter bridges several devices (give each its own `id`; `device.via_device`
 *        links them to the bridge; `availability` replaces the default `<name>/connected` entry,
 *        e.g. to add a per-device online topic). Devices missing from a later result get their
 *        retained announcement cleared.
 * @param {string[]} [a.discoveryTriggers] status items whose change re-publishes discovery
 * @param {number} [a.discoveryDelay] ms to coalesce trigger-driven re-publishes (default 1000)
 * @param {(parts: string[], value: *, topic: string, raw: string) => Promise<void> | void} [a.onSet]
 *        handles <name>/set/<parts...>; throw/reject to have the failure logged at warn
 * @param {Object<string, Function>} [a.subscriptions] additional topics under <name>/ the adapter
 *        handles besides set/#: {'paramset/#': handler, 'rpc/+/+/+': handler}. Patterns use the
 *        MQTT wildcards + (one level) and # (the rest, at least one level); the handler is called
 *        like onSet with the levels the wildcards captured as `parts`
 * @param {Object<string, Function>} [a.listen] topics **anywhere on the broker**, not under
 *        <name>/: {'+/status/#': handler, '$SYS/#': handler}. For a sink — an adapter whose job is
 *        other adapters' traffic (influx4mqtt, mqtt2elasticsearch) rather than a device of its
 *        own. The handler gets `(topic, value, raw, packet)`, not the captured levels a
 *        `subscriptions` handler gets: what a sink works on is the whole topic, and `packet.retain`
 *        is what tells it whether this is live traffic or the broker replaying its backlog.
 *        The adapter's own topics are matched first, so a pattern like `+/status/#` sees them too.
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
    subscriptions = {},
    listen = {},
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
    const subscriptionList = Object.entries(subscriptions);
    const listenList = Object.entries(listen);
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

    /**
     * Publish a status item (retained by default); tracks last values for discovery / json payloads.
     * `extra` adds fields to the JSON payload next to val/ts/lc, `ts`/`lc` (ms) replace the clock
     * for values that carry a device-side timestamp.
     */
    function pubStatus(item, value, {retain = true, extra, ts, lc} = {}) {
        const {payload, changed} = status.update(item, value, {retain, extra, ts, lc});
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

    /** Re-publish every known status (after an mqtt reconnect). Events (retain: false) are skipped. */
    function republishStatus() {
        for (const item of status.state.keys()) {
            if (!status.isRetained(item)) {
                continue;
            }
            publish(topic('status', item), status.payload(item), {retain: true});
        }
    }

    /** Forget an item and clear its retained payload (e.g. a device that is gone). */
    function clearStatus(item) {
        const known = status.delete(item);
        if (known && mqttConnected) {
            publish(topic('status', item), '', {retain: true});
        }
        return known;
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

    // ── process stats: <name>/maintenance/stats every --stats-interval seconds ────────────────
    let statsTimer = null;
    let lastCpu = process.cpuUsage();
    let lastCpuAt = process.hrtime.bigint();
    let lagProbe = null;
    let lagMax = 0;

    /** The stats payload; cpu is the share of one core since the previous call. */
    function statsPayload() {
        const now = process.hrtime.bigint();
        const cpu = process.cpuUsage(lastCpu);
        const elapsedUs = Number(now - lastCpuAt) / 1000;
        lastCpu = process.cpuUsage();
        lastCpuAt = now;
        const mem = process.memoryUsage();
        const payload = {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            cpu: elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : 0,
            eventLoopLag: Math.round(lagMax),
            uptime: Math.round(process.uptime()),
            ts: Date.now(),
        };
        lagMax = 0;
        return payload;
    }

    function publishStats() {
        if (mqttConnected) {
            publish(topic('maintenance', 'stats'), statsPayload(), {retain: true});
        }
    }

    function startStats() {
        const seconds = Number(config.statsInterval);
        if (statsTimer || !(seconds > 0)) {
            return;
        }
        // event loop lag: how late a 1 s timer fires, worst case per interval
        let expected = Date.now() + 1000;
        lagProbe = setInterval(() => {
            const late = Date.now() - expected;
            if (late > lagMax) {
                lagMax = late;
            }
            expected = Date.now() + 1000;
        }, 1000);
        lagProbe.unref();
        statsTimer = setInterval(publishStats, seconds * 1000);
        statsTimer.unref();
    }

    function stopStats() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
        if (lagProbe) {
            clearInterval(lagProbe);
            lagProbe = null;
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
        return devices
            .filter(Boolean)
            .map(({id, device, components, availabilityMin, availability, availabilityMode}) =>
                devicePayload({
                    pkg,
                    name,
                    prefix: config.haPrefix,
                    id: id || discoveryId(pkg.name, name),
                    device,
                    components,
                    availabilityMin,
                    availability,
                    availabilityMode,
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

    function handleMessage(t, raw, packet) {
        raw = raw.toString();
        log.debug('mqtt <', t, raw);
        const levels = t.split('/');
        const [prefix, action, ...parts] = levels;
        // the adapter's own namespace first: a sink pattern like +/status/# matches these too,
        // and `set`/`maintenance` must never be handed to it instead of being acted on
        if (prefix === name && parts.length >= 1 && !parts.includes('')) {
            if (action === 'maintenance') {
                handleMaintenance(parts, raw);
                return;
            }
            if (action === 'set') {
                if (onSet) {
                    dispatch(onSet, 'set', parts, t, raw);
                }
                return;
            }
            for (const [pattern, handler] of subscriptionList) {
                const captured = matchTopic(pattern, [action, ...parts]);
                if (captured) {
                    dispatch(handler, patternLabel(pattern), captured, t, raw);
                    return;
                }
            }
        }
        for (const [pattern, handler] of listenList) {
            if (matchTopic(pattern, levels)) {
                dispatchListen(handler, patternLabel(pattern), t, raw, packet);
                return;
            }
        }
        log.warn('mqtt ignoring unexpected topic', t);
    }

    /** A sink handler: the whole topic and the packet, since that is what it works on. */
    function dispatchListen(handler, label, t, raw, packet) {
        const value = parsePayload(raw);
        const failed = (err) => {
            log.warn(deviceLabel, label, t, 'failed:', (err && err.message) || err);
        };
        try {
            Promise.resolve(handler(t, value, raw, packet || {})).catch(failed);
        } catch (err) {
            failed(err);
        }
    }

    function dispatch(handler, label, parts, t, raw) {
        const value = parsePayload(raw);
        const failed = (err) => {
            log.warn(deviceLabel, label, parts.join('/'), 'failed:', (err && err.message) || err);
        };
        try {
            Promise.resolve(handler(parts, value, t, raw)).catch(failed);
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
            startStats();

            const subs = [topic('set', '#')];
            if (config.maintenance) {
                subs.push(topic('maintenance', 'set', '+'));
            }
            for (const pattern of Object.keys(subscriptions)) {
                subs.push(topic(pattern));
            }
            // a sink's patterns are absolute — never under <name>/
            subs.push(...Object.keys(listen));
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
        stopStats();
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
        clearStatus,
        republishStatus,
        publishInfo,
        infoPayload,
        publishStats,
        statsPayload,
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
