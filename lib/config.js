/**
 * Config loader: yargs CLI + <ENVPREFIX>_* environment variables, precedence CLI > env > defaults,
 * no config file (D-7). The canonical option set every adapter shares lives here; adapters add
 * their device-specific options. Because options are passed as plain objects the same definitions
 * also produce a JSON Schema (`--config-schema`, consumed by the fleet manager).
 */

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

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

/** Options that are not part of an instance configuration (never written to env files / schema). */
export const META_OPTIONS = ['install', 'uninstall', 'config-schema', 'help', 'version'];

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

function allOptions({options = {}, defaults = {}}) {
    const merged = {...options};
    for (const [key, def] of Object.entries(SHARED_OPTIONS)) {
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
 * the kebab-case option name, with `x-env` carrying the environment variable name and `x-secret`
 * marking options that a management UI must mask (`secret: true` in the option definition).
 * `x-adapter` carries name, version, envPrefix and the package's `mqttInterfaces` field, if any.
 */
export function configSchema({pkg, envPrefix, options, defaults, scriptName}) {
    const properties = {};
    const required = [];
    for (const [key, def] of Object.entries(allOptions({options, defaults}))) {
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
    examples = [],
    epilog,
    check,
    argv = hideBin(process.argv),
    env = process.env,
    exit = process.exit,
    print = console.log,
}) {
    applySharedEnv(env, envPrefix);
    const merged = allOptions({options, defaults});
    if (argv.includes('--config-schema')) {
        // before yargs, so required options do not get in the way
        print(JSON.stringify(configSchema({pkg, envPrefix, options, defaults, scriptName}), null, 2));
        exit(0);
        return {};
    }
    let y = yargs(argv).scriptName(scriptName).usage('Usage: $0 [options]');
    for (const [key, def] of Object.entries(merged)) {
        // env vars become typed defaults: CLI > env > defaults (yargs' own .env() only reads process.env)
        const fromEnv = env[envVarName(key, envPrefix)];
        // `secret` is schema metadata only, not a yargs option property
        // eslint-disable-next-line no-unused-vars
        const {secret, ...yargsDef} = def;
        const withEnv =
            fromEnv === undefined ? yargsDef : {...yargsDef, default: coerce(fromEnv, def.type), demandOption: false};
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
