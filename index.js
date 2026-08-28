/**
 * mqtt-interfaces-core — the shared ~80% of every xyz2mqtt adapter.
 *
 * Implements mqtt-smarthome spec 2.x (SPEC_VERSION): `connected` 0/1/2 with LWT, retained
 * `status/<item>` (plain or {val, ts, lc}), `set/<item>` dispatch, `<name>/info`,
 * `maintenance/set/{loglevel,restart}`, Home Assistant device discovery, graceful shutdown,
 * CLI + env config with JSON Schema export, journald-aware logging and a systemd installer.
 */

export const SPEC_VERSION = '2.0';

export {createAdapter, matchTopic} from './lib/adapter.js';
export {createLogger, detectFormat, LEVELS} from './lib/log.js';
export {parsePayload, toBoolean, clampInt, toVolume, StatusTracker} from './lib/payload.js';
export {parseConfig, configSchema, applySharedEnv, SHARED_OPTIONS, SHARED_ENV} from './lib/config.js';
export {discoveryId, discoveryTopic, availability, entity, devicePayload} from './lib/hadiscovery.js';
export {createInstaller, envVarName, instanceName} from './lib/install.js';
export {
    discover,
    discoverOne,
    autoAddress,
    runDiscovery,
    describe as describeDevice,
    DiscoveryError,
    DISCOVERY_OPTIONS,
    ssdpSearch,
    mdnsQuery,
    udpProbe,
    tcpProbe,
    arpTable,
    listSerialPorts,
    serialMatches,
    localSubnets,
    localBroadcasts,
    subnetHosts,
    parseCidr,
    pool,
} from './lib/discovery.js';
