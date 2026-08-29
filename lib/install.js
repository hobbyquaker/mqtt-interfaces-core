/**
 * --install / --uninstall: run an adapter as a systemd template service, one instance per device.
 *
 *   <service>@<name>.service             instance = --name (= mqtt topic prefix)
 *   /etc/<service>/<name>.env            per-instance config (<ENVPREFIX>_* variables)
 *   /etc/mqtt-interfaces/broker.env      optional shared broker config (MQTT_URL, MQTT_USERNAME, ...; B-3)
 *   /var/lib/<service>/<name>/           per-instance state (StateDirectory)
 *   system user <service>                shared by all instances
 *
 * Restart=always so that `maintenance/set/restart` (clean exit) comes back up.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {envVarName as envName, META_OPTIONS} from './config.js';

export const BROKER_ENV_FILE = '/etc/mqtt-interfaces/broker.env';

export function envVarName(option, envPrefix) {
    return envName(option, envPrefix);
}

export function instanceName(name) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        throw new Error(`--name "${name}" cannot be used as systemd instance name (allowed: letters, digits, _ . -)`);
    }
    return name;
}

function run(cmd, args) {
    return execFileSync(cmd, args, {stdio: ['ignore', 'pipe', 'inherit']})
        .toString()
        .trim();
}

/**
 * @param {object} i
 * @param {string} i.service adapter/service name, e.g. "lgtv2mqtt"
 * @param {string} i.envPrefix e.g. "LGTV2MQTT"
 * @param {string} [i.description] unit Description (instance is appended)
 * @param {string} [i.documentation] unit Documentation URL
 * @param {string[]} [i.envOptions] camelCased option names written to the env file
 *        (default: every option of config.$options except name and the meta options)
 * @param {Object<string, string>} [i.environment] extra `Environment=K=V` lines (may use %i, %S)
 * @param {string[]} [i.serviceExtra] extra `[Service]` lines, e.g. `SupplementaryGroups=dialout`
 * @param {string} [i.user] the unit's User=/Group= (default: the service's own system user). `root`
 *        skips creating a user and is for an adapter that genuinely needs it — mqttpc, which
 *        exists to run other programs. An adapter that talks to a device never needs it.
 * @param {boolean} [i.hardening] emit `NoNewPrivileges`, `ProtectSystem`, `ProtectHome` and
 *        `PrivateTmp` (default true). An adapter that spawns other programs has to turn this off:
 *        the sandbox is inherited by every child, so `ProtectHome` hides /home from a backup
 *        script and `NoNewPrivileges` stops `sudo` from working at all.
 * @param {(ctx: {name: string, argv: object, stateDir: string, log: Function}) => void} [i.beforeStart]
 *        hook after directories exist and before the unit is enabled (e.g. copy a pairing key)
 * @param {{exec?: Function, fs?: object}} [i.deps] for tests
 */
export function createInstaller({
    service,
    envPrefix,
    description = `${service} %i`,
    documentation,
    envOptions,
    environment = {},
    serviceExtra = [],
    user,
    hardening = true,
    beforeStart,
}) {
    const runAs = user || service;
    const ownUser = runAs === service;
    const UNIT_PATH = `/etc/systemd/system/${service}@.service`;
    const CONF_DIR = `/etc/${service}`;
    const STATE_DIR = `/var/lib/${service}`;

    const envPath = (name) => path.join(CONF_DIR, `${name}.env`);
    const unitName = (name) => `${service}@${name}.service`;

    function unitFile(execStart) {
        const extraEnv =
            Object.entries(environment)
                .map(([k, v]) => `Environment=${k}=${v}\n`)
                .join('') + serviceExtra.map((line) => `${line}\n`).join('');
        return `[Unit]
Description=${description}
${documentation ? `Documentation=${documentation}\n` : ''}After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-${BROKER_ENV_FILE}
EnvironmentFile=${CONF_DIR}/%i.env
Environment=${envPrefix}_NAME=%i
${extraEnv}ExecStart=${execStart}
Restart=always
RestartSec=10
SyslogIdentifier=${service}@%i
SyslogLevelPrefix=true
User=${runAs}
Group=${runAs}
StateDirectory=${service}/%i
${
    hardening
        ? `NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
`
        : ''
}
[Install]
WantedBy=multi-user.target
`;
    }

    function optionsFor(argv) {
        if (envOptions) {
            return envOptions;
        }
        const defs = argv.$options || {};
        return Object.keys(defs)
            .filter((k) => k !== 'name' && !META_OPTIONS.includes(k))
            .map((k) => k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()));
    }

    /** Build the env file content from the parsed CLI options (everything except --name). */
    function envFile(argv) {
        const lines = [
            `# ${service} instance "${argv.name}" - read by ${unitName(argv.name)}.`,
            `# Edit and run: systemctl restart ${unitName(argv.name)}`,
            `# Broker settings can also go to ${BROKER_ENV_FILE} (MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD).`,
        ];
        for (const option of optionsFor(argv)) {
            const value = argv[option];
            if (value === undefined || value === null || value === '') {
                continue;
            }
            lines.push(`${envVarName(option, envPrefix)}=${String(value).replace(/\n/g, ' ')}`);
        }
        return lines.join('\n') + '\n';
    }

    function installedInstances() {
        if (!fs.existsSync(CONF_DIR)) {
            return [];
        }
        return fs
            .readdirSync(CONF_DIR)
            .filter((f) => f.endsWith('.env'))
            .map((f) => f.slice(0, -4));
    }

    function requireRoot(option) {
        if (os.platform() !== 'linux') {
            throw new Error(`${option} is only supported on Linux with systemd`);
        }
        if (typeof process.getuid === 'function' && process.getuid() !== 0) {
            throw new Error(`${option} must run as root, e.g. sudo ${service} ${option} --name <name> ...`);
        }
        if (!fs.existsSync('/run/systemd/system')) {
            throw new Error('systemd is not running on this system');
        }
    }

    /** Install instance `argv.name` as systemd service, enable and start it. Must run as root. */
    function installService(argv, log = console.log) {
        requireRoot('--install');
        const name = instanceName(argv.name);
        const execStart = `${process.execPath} ${fs.realpathSync(process.argv[1])}`;

        // root always exists; any other name is the service's own user, created on first install
        if (ownUser) {
            try {
                run('id', ['-u', service]);
            } catch {
                log(`creating system user ${service}`);
                run('useradd', [
                    '--system',
                    '--no-create-home',
                    '--home-dir',
                    STATE_DIR,
                    '--shell',
                    '/usr/sbin/nologin',
                    service,
                ]);
            }
        } else {
            run('id', ['-u', runAs]); // a user that does not exist would leave the unit unstartable
        }

        const stateDir = path.join(STATE_DIR, name);
        fs.mkdirSync(stateDir, {recursive: true, mode: 0o750});
        if (beforeStart) {
            beforeStart({name, argv, stateDir, log});
        }
        run('chown', ['-R', `${runAs}:${runAs}`, STATE_DIR]);

        fs.mkdirSync(CONF_DIR, {recursive: true, mode: 0o750});
        const conf = envPath(name);
        if (fs.existsSync(conf)) {
            fs.copyFileSync(conf, conf + '.bak');
            log(`existing ${conf} backed up to ${conf}.bak`);
        }
        fs.writeFileSync(conf, envFile(argv), {mode: 0o640});
        // the config holds broker credentials: readable by the unit's user, writable only by root
        run('chown', ['-R', `root:${runAs}`, CONF_DIR]);
        log(`wrote ${conf}`);

        // template unit (shared by all instances, rewritten so ExecStart follows node/package updates)
        fs.writeFileSync(UNIT_PATH, unitFile(execStart), {mode: 0o644});
        log(`wrote ${UNIT_PATH} (ExecStart=${execStart})`);

        run('systemctl', ['daemon-reload']);
        run('systemctl', ['enable', '--now', unitName(name)]);
        const others = installedInstances().filter((i) => i !== name);
        if (others.length > 0) {
            log(`other instances: ${others.map(unitName).join(', ')}`);
        }
        log(`${unitName(name)} enabled and started. logs: journalctl -u ${unitName(name)} -f`);
    }

    /** Stop, disable and remove instance `argv.name`; remove the template when it was the last one. */
    function uninstallService(argv, log = console.log) {
        requireRoot('--uninstall');
        const name = instanceName(argv.name);
        const unit = unitName(name);

        try {
            run('systemctl', ['disable', '--now', unit]);
        } catch {
            // not installed
        }
        const conf = envPath(name);
        if (fs.existsSync(conf)) {
            fs.rmSync(conf);
            log(`removed ${conf}`);
        }
        const remaining = installedInstances();
        if (remaining.length === 0 && fs.existsSync(UNIT_PATH)) {
            fs.rmSync(UNIT_PATH);
            log(`removed ${UNIT_PATH} (no instances left)`);
        }
        run('systemctl', ['daemon-reload']);
        log(`${unit} removed. state kept in ${path.join(STATE_DIR, name)}; delete it manually if no longer needed.`);
        if (remaining.length > 0) {
            log(`remaining instances: ${remaining.map(unitName).join(', ')}`);
        }
    }

    /** Handle --install/--uninstall if given: runs and exits the process. Returns false otherwise. */
    function handle(argv, log = console.log) {
        if (!argv.install && !argv.uninstall) {
            return false;
        }
        try {
            if (argv.uninstall) {
                uninstallService(argv, log);
            } else {
                installService(argv, log);
            }
            process.exit(0);
        } catch (err) {
            console.error('error:', err.message);
            process.exit(1);
        }
    }

    return {
        service,
        UNIT_PATH,
        CONF_DIR,
        STATE_DIR,
        unitFile,
        envFile,
        unitName,
        installService,
        uninstallService,
        handle,
    };
}
