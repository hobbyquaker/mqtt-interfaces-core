/**
 * Config loader: yargs CLI + <ENVPREFIX>_* environment variables, precedence CLI > env > defaults,
 * no config file (D-7). The canonical option set every adapter shares lives here; adapters add
 * their device-specific options. Because options are passed as plain objects the same definitions
 * also produce a JSON Schema (`--config-schema`, consumed by the fleet manager).
 */

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import {discoveryOptions, discoveryKinds, discoveryNeeds} from './discovery.js';
import {printSync} from './print.js';

/**
 * Unprefixed broker variables read as fallback when <ENVPREFIX>_<X> is absent (B-3) — what a
 * shared /etc/mqtt-interfaces/broker.env holds. The client id prefix is deliberately not shared:
 * it is per adapter/instance (<ADAPTER>_MQTT_CLIENT_ID_PREFIX), a common prefix would only make
 * client ids of different adapters look alike.
 */
export const SHARED_ENV = ['MQTT_URL', 'MQTT_USERNAME', 'MQTT_PASSWORD', 'MQTT_TLS_CA'];

/** Options every adapter has. `name` gets its default from the adapter. */
export const SHARED_OPTIONS = {
    'mqtt-url': {
        alias: ['u', 'url'],
        type: 'string',
        describe: 'mqtt broker url, e.g. mqtt://broker or mqtts://user:pass@broker:8883',
        default: 'mqtt://localhost',
    },
    'mqtt-username': {type: 'string', describe: 'mqtt broker username'},
    'mqtt-password': {type: 'string', describe: 'mqtt broker password', secret: true},
    'mqtt-client-id-prefix': {type: 'string', describe: 'prefix for the mqtt client id (<prefix><name>_<random>)'},
    'mqtt-tls-ca': {type: 'string', describe: 'path to a CA certificate file for mqtts:// connections'},
    name: {
        alias: 'n',
        type: 'string',
        describe: 'instance name. used as mqtt client id and as prefix for topics',
    },
    'json-payloads': {
        type: 'boolean',
        describe: 'publish status as JSON {"val": ..., "ts": ..., "lc": ...} (use --no-json-payloads for plain values)',
        default: true,
    },
    'ha-discovery': {
        type: 'boolean',
        describe: 'publish Home Assistant MQTT discovery (use --no-ha-discovery to disable and clear)',
        default: true,
    },
    'ha-prefix': {type: 'string', describe: 'Home Assistant discovery prefix', default: 'homeassistant'},
    maintenance: {
        type: 'boolean',
        describe: 'accept <name>/maintenance/set/loglevel and /restart over mqtt (use --no-maintenance to disable)',
        default: true,
    },
    'stats-interval': {
        type: 'number',
        describe: 'seconds between <name>/maintenance/stats (memory, cpu, event loop lag); 0 disables',
        default: 60,
    },
    verbosity: {
        alias: 'v',
        type: 'string',
        describe: 'log level',
        choices: ['error', 'warn', 'info', 'debug'],
        default: 'info',
    },
    install: {
        type: 'boolean',
        describe:
            'install as systemd service <adapter>@<name> using the other options as its config, enable and start it. needs root',
    },
    uninstall: {
        type: 'boolean',
        describe: 'stop, disable and remove the systemd service <adapter>@<name>. needs root',
    },
    'config-schema': {
        type: 'boolean',
        describe: 'print the JSON Schema of all options and exit',
    },
};

/** Formats a `file` option may declare; anything else is treated as text. */
export const FILE_FORMATS = ['json', 'yaml', 'text', 'binary'];

/** Options that are not part of an instance configuration (never written to env files / schema). */
export const META_OPTIONS = [
    'install',
    'uninstall',
    'config-schema',
    'discover',
    'discover-json',
    'discover-timeout',
    'discover-address',
    'discover-ip',
    'help',
    'version',
];

export function envVarName(option, envPrefix) {
    const kebab = option.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    return `${envPrefix}_${kebab.replace(/-/g, '_').toUpperCase()}`;
}

/** Copy unprefixed MQTT_* variables to <ENVPREFIX>_MQTT_* when those are not set. Mutates and returns env. */
export function applySharedEnv(env, envPrefix) {
    for (const key of SHARED_ENV) {
        const prefixed = `${envPrefix}_${key}`;
        if (env[prefixed] === undefined && env[key] !== undefined) {
            env[prefixed] = env[key];
        }
    }
    return env;
}

/** Convert an environment variable string to the option's type. */
export function coerce(value, type) {
    switch (type) {
        case 'boolean':
            return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
        case 'number': {
            const n = Number(value);
            return Number.isFinite(n) ? n : value;
        }
        case 'array':
            return String(value)
                .split(/[,\s]+/)
                .filter(Boolean);
        default:
            return value;
    }
}

/**
 * Shared options that only mean something for an adapter that publishes device state. A sink —
 * influx4mqtt, mqtt2elasticsearch — subscribes and forwards; it has no items and no entities, so
 * these configure nothing. Left in, they show up in `--help`, in `--config-schema` (and so in a
 * config UI, where someone will reasonably try to use them) and get written to the env file.
 */
const STATE_OPTIONS = {
    publishesStatus: ['json-payloads'],
    publishesDiscovery: ['ha-discovery', 'ha-prefix'],
};

function allOptions({
    options = {},
    defaults = {},
    discovery = false,
    publishesStatus = true,
    publishesDiscovery = true,
}) {
    const merged = {...options, ...(discovery ? discoveryOptions(discovery) : {})};
    const omit = new Set([
        ...(publishesStatus ? [] : STATE_OPTIONS.publishesStatus),
        ...(publishesDiscovery ? [] : STATE_OPTIONS.publishesDiscovery),
    ]);
    for (const [key, def] of Object.entries(SHARED_OPTIONS)) {
        if (omit.has(key) && !options[key]) {
            continue; // an adapter that declares it itself keeps it
        }
        if (!merged[key]) {
            merged[key] = {...def};
        }
        if (key in defaults) {
            merged[key] = {...merged[key], default: defaults[key]};
        }
    }
    return merged;
}

/**
 * JSON Schema (draft 2020-12) of the instance configuration: one property per option, keyed by
 * the kebab-case option name, with `x-env` carrying the environment variable name, `x-secret`
 * marking options that a management UI must mask (`secret: true` in the option definition) and
 * `x-file` describing options that hold a path to a file the user maintains (`file: {...}`):
 *   format   'json' | 'yaml' | 'text' | 'binary'   (binary: show, do not edit)
 *   example  path of an example file, relative to the package root, to create the file from
 *   schema   path of a JSON Schema for the file's content, relative to the package root
 *   describe what the file is for (defaults to the option's describe)
 * `x-adapter` carries name, version, envPrefix and the package's `mqttInterfaces` field, if any.
 *
 * `x-discover` marks the one property that receives what `--discover` finds — the property that
 * also accepts `auto` (`ccu-address`, `serialport`, …), flagged with `discover: true` in the
 * option definition. Its value is the kind of scanning, derived from the adapter's hint:
 * `'network'`, `'serial'`, `'cloud'`, or several. A schema with an `x-discover` property is a
 * discovery-capable adapter; there is no separate flag (she I13). `'cloud'` is the odd one — it
 * scans nothing, it asks the vendor which devices the account owns, so a UI offering it must
 * collect the credentials named by the hint's `needs` first (ecoflow2mqtt: email + password).
 *
 * How many devices go in is the property's own `type`: a `string` property takes the one device
 * `autoAddress` insists on, an `array` one takes every hit from `autoAddresses` — a bridge like
 * govee2mqtt is one instance for the whole LAN, so its `address` list is filled with all of them.
 *
 * `x-discover-needs` lists the option names the scan itself consumes, when it needs any
 * (`["email", "password"]` for a cloud hint). A UI must have those values before it can offer the
 * scan, and must pass them to the `--discover` run; without them the adapter refuses, since these
 * are exactly the options `--discover` keeps demanding. They are options of the instance being
 * configured, so a UI already collects them — this only says which ones are needed *first*.
 */
export function configSchema({
    pkg,
    envPrefix,
    options,
    defaults,
    scriptName,
    discovery,
    publishesStatus = true,
    publishesDiscovery = true,
}) {
    const properties = {};
    const required = [];
    const kinds = discoveryKinds(discovery);
    const needs = discoveryNeeds(discovery);
    for (const [key, def] of Object.entries(allOptions({options, defaults, publishesStatus, publishesDiscovery}))) {
        if (META_OPTIONS.includes(key)) {
            continue;
        }
        const prop = {};
        if (def.type === 'array') {
            prop.type = 'array';
            prop.items = {type: 'string'};
        } else if (def.type) {
            prop.type = def.type;
        }
        if (def.describe) {
            prop.description = def.describe;
        }
        if (def.default !== undefined) {
            prop.default = def.default;
        }
        if (def.choices) {
            prop.enum = def.choices;
        }
        prop['x-env'] = envVarName(key, envPrefix);
        if (def.secret) {
            prop['x-secret'] = true;
        }
        if (def.discover && kinds.length > 0) {
            prop['x-discover'] = kinds.length === 1 ? kinds[0] : kinds;
            if (needs.length > 0) {
                // what the scan itself consumes, so a UI collects it before offering the scan
                prop['x-discover-needs'] = needs;
            }
        }
        if (def.file && typeof def.file === 'object') {
            const f = {format: FILE_FORMATS.includes(def.file.format) ? def.file.format : 'text'};
            for (const k of ['example', 'schema', 'describe']) {
                if (typeof def.file[k] === 'string' && def.file[k]) {
                    f[k] = def.file[k];
                }
            }
            prop['x-file'] = f;
        }
        if (def.demandOption || def.required) {
            required.push(key);
        }
        properties[key] = prop;
    }
    const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: pkg.homepage ? `${pkg.homepage.replace(/#.*$/, '')}/config.schema.json` : undefined,
        title: scriptName || pkg.name,
        description: pkg.description,
        type: 'object',
        properties,
        additionalProperties: false,
        'x-adapter': {
            name: pkg.name,
            version: pkg.version,
            envPrefix,
            ...(pkg.mqttInterfaces && {mqttInterfaces: pkg.mqttInterfaces}),
        },
    };
    if (required.length > 0) {
        schema.required = required;
    }
    if (!schema.$id) {
        delete schema.$id;
    }
    return schema;
}

/**
 * Parse CLI + env into a config object (camelCased keys, like yargs). Handles `--config-schema`
 * (prints the schema and exits) and the shared MQTT_* env fallback.
 *
 * @param {object} input
 * @param {{name: string, version: string, homepage?: string, description?: string}} input.pkg
 * @param {string} [input.scriptName] default pkg.name
 * @param {string} [input.envPrefix] default scriptName upper-cased (LGTV2MQTT)
 * @param {Object<string, object>} [input.options] adapter-specific yargs option definitions
 * @param {Object<string, *>} [input.defaults] overrides for shared option defaults, e.g. {name: 'lgtv'}
 * @param {Array<[string, string]>} [input.examples]
 * @param {string} [input.epilog]
 * @param {boolean} [input.publishesStatus] false for an adapter that publishes no status items —
 *        a sink forwards messages and has none, so `--json-payloads` configures nothing
 * @param {boolean} [input.publishesDiscovery] false for an adapter that announces no Home
 *        Assistant entities, i.e. one that passes no `discovery` to `createAdapter()`. Then
 *        `--ha-discovery` / `--ha-prefix` are dropped rather than offered and ignored
 * @param {object|boolean} [input.discovery] the adapter's discovery hint: adds the --discover*
 *        options (handled by runDiscovery, see lib/discovery.js) and, when it is the hint object
 *        rather than just `true`, marks the option flagged `discover: true` with `x-discover`
 *        in the schema so a management UI can offer the scan (she I13)
 * @param {(argv: object) => boolean} [input.check] yargs .check()
 * @param {string[]} [input.argv] default process.argv (without node + script)
 * @param {object} [input.env] default process.env
 */
export function parseConfig({
    pkg,
    scriptName = pkg.name,
    envPrefix = scriptName.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
    options = {},
    defaults = {},
    discovery = false,
    publishesStatus = true,
    publishesDiscovery = true,
    examples = [],
    epilog,
    check,
    argv = hideBin(process.argv),
    env = process.env,
    exit = process.exit,
    print = printSync,
}) {
    applySharedEnv(env, envPrefix);
    const merged = allOptions({options, defaults, discovery, publishesStatus, publishesDiscovery});
    if (argv.includes('--config-schema')) {
        // before yargs, so required options do not get in the way
        print(
            JSON.stringify(
                configSchema({
                    pkg,
                    envPrefix,
                    options,
                    defaults,
                    scriptName,
                    discovery,
                    publishesStatus,
                    publishesDiscovery,
                }),
                null,
                2,
            ),
        );
        exit(0);
        return {};
    }
    // --uninstall only needs --name, --discover needs nothing at all: an adapter's mandatory
    // options (the device address we are about to go looking for) must not block either.
    // Except what the scan itself consumes — a cloud hint cannot list an account without its
    // credentials, and dropping them turns a missing option into an api error further down.
    const uninstalling = argv.includes('--uninstall') || argv.includes('--discover');
    const stillNeeded = new Set(argv.includes('--discover') ? discoveryNeeds(discovery) : []);
    let y = yargs(argv).scriptName(scriptName).usage('Usage: $0 [options]');
    for (const [key, def] of Object.entries(merged)) {
        // env vars become typed defaults: CLI > env > defaults (yargs' own .env() only reads process.env)
        const fromEnv = env[envVarName(key, envPrefix)];
        // `secret`, `file` and `discover` are schema metadata only, not yargs option properties
        // eslint-disable-next-line no-unused-vars
        const {secret, file, discover, ...yargsDef} = def;
        let withEnv =
            fromEnv === undefined ? yargsDef : {...yargsDef, default: coerce(fromEnv, def.type), demandOption: false};
        if (uninstalling && withEnv.demandOption && !stillNeeded.has(key)) {
            withEnv = {...withEnv, demandOption: false};
        }
        y = y.option(key, withEnv);
    }
    for (const [cmd, desc] of examples) {
        y = y.example(cmd, desc);
    }
    if (check) {
        y = y.check(check);
    }
    y = y
        .epilog(
            epilog ||
                `Every option can also be set via environment variable, e.g. ${envVarName('mqtt-url', envPrefix)}, ` +
                    `${envVarName('name', envPrefix)}. The unprefixed MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD ` +
                    `are used as fallback.\n${pkg.homepage || ''}`,
        )
        .version(pkg.version)
        .help('help')
        .alias('h', 'help')
        .strict();
    const parsed = y.parse();
    Object.defineProperty(parsed, '$options', {value: merged, enumerable: false});
    Object.defineProperty(parsed, '$envPrefix', {value: envPrefix, enumerable: false});
    return parsed;
}
