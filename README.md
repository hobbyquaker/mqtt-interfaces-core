# mqtt-interfaces-core

Core library for writing `xyz2mqtt` interfaces ("adapters") in Node.js that follow the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention (spec 2.x).
It absorbs the ~80% every adapter repeats so an adapter is left with its device protocol and
an item table.

**Status: 0.x — API may still change.** Adapters on the core: lgtv2mqtt 3, cul2mqtt 1,
alexa-remote-mqtt 2, lgsb2mqtt 2. See [ROADMAP.md](ROADMAP.md).

Contents: [What you get](#what-you-get) · [Minimal adapter](#minimal-adapter) ·
[Building an adapter](#building-an-adapter) (the complete guide) ·
[Conventions implemented](#conventions-implemented) · [API](#api) ·
[Management UIs: she](#management-uis-she)

## What you get

- **`createAdapter()`** — MQTT connection with LWT, `<name>/connected` `0`/`1`/`2`, retained
  `status/<item>` (`{val, ts, lc}` JSON, or plain values with `--no-json-payloads`), `set/<item>` dispatch with
  plain and `{val}` payloads, status re-publish after reconnect, `<name>/info`,
  `maintenance/set/loglevel` + `restart`, Home Assistant device discovery (re)publishing,
  graceful shutdown on SIGINT/SIGTERM.
- **`parseConfig()`** — yargs CLI with the canonical shared option set plus your own options,
  `<ADAPTER>_*` env vars, unprefixed `MQTT_URL`/`MQTT_USERNAME`/`MQTT_PASSWORD`/`MQTT_TLS_CA` fallback,
  `--config-schema` (JSON Schema of all options, with `x-env` / `x-secret` / `x-file`, for management UIs).
- **`createLogger()`** — levels, journald detection (`<N>` priority prefixes, no own timestamp
  under systemd), `<ADAPTER>_LOG_FORMAT=journal|text`, runtime level changes.
- **payload helpers** — `parsePayload`, `toBoolean`, `clampInt`, `toVolume`, `StatusTracker`.
- **HA discovery helpers** — `entity()`, `devicePayload()`, `availability()`, `discoveryId()`.
- **`createInstaller()`** — `--install`/`--uninstall` as systemd template unit
  `<adapter>@<name>`, `/etc/<adapter>/<name>.env`, shared `/etc/mqtt-interfaces/broker.env`.

## Minimal adapter

```js
#!/usr/bin/env node
import {createAdapter, parseConfig, createInstaller, entity, toVolume} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};

const config = parseConfig({
  pkg,
  defaults: {name: 'foo'},
  options: {
    address: {alias: 'a', type: 'string', describe: 'device address', demandOption: true},
  },
  examples: [['$0 -a 192.168.1.20 -u mqtt://broker', 'run in the foreground']],
});

createInstaller({service: pkg.name, envPrefix: config.$envPrefix}).handle(config);

const adapter = createAdapter({
  pkg,
  config,
  deviceLabel: 'foo',
  info: {address: config.address},
  discovery: ({get}) => ({
    device: {mf: 'ACME', ...(get('model') && {mdl: get('model')})},
    components: {
      volume: entity({
        id: `${pkg.name}_${config.name}`,
        name: config.name,
        item: 'volume',
        platform: 'number',
        label: 'Volume',
        command: true,
        jsonPayloads: config.jsonPayloads,
        extra: {min: 0, max: 100},
      }),
    },
  }),
  discoveryTriggers: ['model'],
  onSet: async (parts, value) => {
    if (parts[0] === 'volume') {
      await device.setVolume(toVolume(value));
    }
  },
  onShutdown: () => device.disconnect(),
});

const device = connectToDevice(config.address);
device.on('connect', () => adapter.setDeviceConnected(true));
device.on('close', () => adapter.setDeviceConnected(false));
device.on('volume', (v) => adapter.pubStatus('volume', v));

adapter.start();
```

Every module is also importable on its own (`mqtt-interfaces-core/log`, `/payload`, `/config`,
`/adapter`, `/hadiscovery`, `/install`).

## Building an adapter

Everything you need to know to write a new `xyz2mqtt` adapter, or to port an old one, so that it
behaves like the others and works with she's Services page. cul2mqtt and lgtv2mqtt are the
reference implementations — copy their layout.

### 1. What an adapter is

One process = one instance = one device (or one bridge to several devices) = one MQTT topic prefix
`<name>` (the `--name` option, default per adapter, e.g. `lgtv`). Everything it publishes lives
under `<name>/`; everything it accepts arrives under `<name>/set/`. Several instances of the same
adapter run side by side as systemd template units `<adapter>@<name>` with their own config file.

The adapter owns its device protocol and an item table; the core owns MQTT, config, logging,
discovery, installation and the maintenance topics. If you find yourself writing any of the latter
in an adapter, it belongs in the core.

### 2. Project skeleton

```
xyz2mqtt/
├── index.js            entry point (#!/usr/bin/env node): createAdapter + the device part
├── config.js           parseConfig() with the adapter's options; exports OPTIONS + default
├── lib/
│   ├── install.js      createInstaller() wired to the adapter (serviceExtra, beforeStart)
│   ├── hadiscovery.js  pure: items → HA entity map
│   └── ...             pure protocol / mapping modules (testable without a device)
├── test/*.test.js      node:test unit tests for every lib module + the installer
├── example-*.json      example files for user-maintained files (map files) + JSON schemas
├── package.json        see below
├── README.md           options table, topics, HA, install, changelog pointer
├── CHANGELOG.md        `## x.y.z` sections; the release notes are generated from them
├── ROADMAP.md / AGENTS.md   plan and agent notes (optional but the fleet does it)
├── Dockerfile          node:22-alpine, env config (template below)
├── .dockerignore       node_modules, .git, .github, *.md, test, scripts, deploy.sh
├── deploy.sh           dev deploy to a host by tarball (from cul2mqtt)
├── eslint.config.js, .prettierrc, .editorconfig   copies of the core's
└── .github/workflows/ci.yml, release.yml, .github/release-notes.js   copies of the core's
```

`package.json`:

```json
{
  "name": "xyz2mqtt",
  "version": "1.0.0",
  "description": "Interface between XYZ and MQTT",
  "type": "module",
  "main": "index.js",
  "bin": {"xyz2mqtt": "index.js"},
  "preferGlobal": true,
  "files": ["index.js", "config.js", "lib/", "example-map.json", "map.schema.json"],
  "engines": {"node": "^20.19 || ^22.12 || >=24"},
  "scripts": {
    "start": "node index.js",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write . && eslint --fix .",
    "test": "node --test",
    "deploy": "bash deploy.sh"
  },
  "keywords": ["mqtt", "mqtt-smarthome", "home-automation", "home-assistant", "xyz"],
  "mqttInterfaces": {"spec": "2.0", "envPrefix": "XYZ2MQTT", "needs": [], "serviceExtra": []},
  "dependencies": {"mqtt-interfaces-core": "^0.6.0"},
  "devDependencies": {
    "@eslint/js": "^9",
    "eslint": "^9",
    "eslint-config-prettier": "^10",
    "globals": "^16",
    "prettier": "^3"
  }
}
```

- Plain JavaScript, ES modules, no TypeScript, no build step. Node ≥ 20.19.
- Minimal dependencies: adapters run on Raspberry-class machines. `mqtt` and `yargs` come with the
  core — do not depend on them yourself.
- The npm package name **is** the adapter name: it names the systemd template unit, the config
  directory `/etc/<adapter>/`, the state directory `/var/lib/<adapter>/`, the system user and the
  default env prefix (`XYZ2MQTT_`, non-alphanumerics → `_`). Lower case, no scope.
- `mqttInterfaces` is optional metadata for catalogs (see [Management UIs](#management-uis-she)):
  `spec` — implemented spec version; `envPrefix`; `needs` — what the adapter talks to, shown as
  badges by catalogs: `network` (a device or service on the LAN), `cloud` (a vendor service on the
  internet), `serial` (a serial/USB device — add the dialout group via `serviceExtra`), `bluetooth`,
  `usb`; several may apply (`["network", "cloud"]`); `serviceExtra` — the extra `[Service]` lines
  the installer adds.

### 3. config.js — options

```js
import {parseConfig} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};

export const OPTIONS = {
  address: {alias: 'a', type: 'string', describe: 'device address (ip or hostname)', demandOption: true},
  port: {type: 'number', describe: 'device port', default: 8080},
  mode: {type: 'string', describe: 'protocol mode', choices: ['auto', 'legacy'], default: 'auto'},
  'poll-interval': {type: 'number', describe: 'seconds between state polls (0 = push only)', default: 60},
  'api-token': {type: 'string', describe: 'device API token', secret: true},
  'map-file': {
    alias: 'm',
    type: 'string',
    describe: 'JSON file with friendly item names (see example-map.json)',
    file: {format: 'json', example: 'example-map.json', schema: 'map.schema.json', describe: 'friendly item names'},
  },
  'publish-raw': {
    type: 'boolean',
    describe: 'additionally publish raw protocol messages on <name>/raw',
    default: false,
  },
};

export default parseConfig({
  pkg,
  options: OPTIONS,
  defaults: {name: 'xyz'},
  examples: [
    ['$0 -a 192.168.1.20 -u mqtt://broker', 'run in the foreground'],
    ['sudo $0 --install -n xyz -a 192.168.1.20 -u mqtt://broker', 'install as service xyz2mqtt@xyz'],
  ],
});
```

What you get and must not redo yourself:

- The **shared options** every adapter has: `--mqtt-url/-u/--url`, `--mqtt-username`,
  `--mqtt-password`, `--mqtt-client-id-prefix`, `--mqtt-tls-ca`, `--name/-n`, `--json-payloads`
  (default on), `--ha-discovery` (default on), `--ha-prefix`, `--maintenance` (default on),
  `--stats-interval` (60 s, 0 = off), `--verbosity/-v`, `--install`, `--uninstall`, `--config-schema`,
  `--help`, `--version`. Override a
  shared default via `defaults` (`{name: 'xyz'}` at least).
- Every option as **environment variable** `<PREFIX>_<OPTION>` (`XYZ2MQTT_POLL_INTERVAL`), typed;
  the unprefixed `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TLS_CA` as fallback (that is
  what `/etc/mqtt-interfaces/broker.env` holds). Precedence: CLI > env > defaults. No config file
  format of your own.
- `config.<camelCase>` values (`config.pollInterval`), plus `config.$options` and
  `config.$envPrefix`.
- **`--config-schema`**: a JSON Schema of the instance configuration, one property per option with
  `x-env`, `enum` for `choices`, `required` for `demandOption` (`--uninstall --name <n>` is exempt from
  mandatory options — it needs only the name), and:
  - `secret: true` → `"x-secret": true` — management UIs mask the value (`--mqtt-password` has it).
    Mark every credential, token, cookie, key.
  - `file: {format, example, schema, describe}` → `"x-file": {…}` — the option holds the path of a
    file the user maintains. `format` is `json`, `yaml`, `text` or `binary` (shown, not edited);
    `example` and `schema` are paths relative to the package root — ship them in `files`. A UI can
    then offer an editor with validation and "create from example".
- Rules: kebab-case option names; `describe` in lower case, one line; sensible defaults that do not
  point at anyone's personal infrastructure; booleans default to the safe side (`--publish-raw`
  off, `--raw-set` off); paths that the service needs at runtime default to the state directory
  (`process.env.STATE_DIRECTORY`, set by systemd) rather than the home directory.

### 4. lib/install.js — the systemd installer

```js
import {createInstaller} from 'mqtt-interfaces-core';

export const SERVICE = 'xyz2mqtt';
export const ENV_PREFIX = 'XYZ2MQTT';

const installer = createInstaller({
  service: SERVICE,
  envPrefix: ENV_PREFIX,
  description: `${SERVICE} %i - XYZ to MQTT bridge`,
  documentation: 'https://github.com/you/xyz2mqtt',
  serviceExtra: ['SupplementaryGroups=dialout'], // only what the device needs
  // beforeStart: ({name, argv, stateDir, log}) => copy a pairing key into stateDir, …
});

export const {unitFile, envFile, installService, uninstallService, handle} = installer;
```

`handle(config)` is the first thing `index.js` calls: with `--install`/`--uninstall` it acts and
exits, otherwise it returns `false`. What `--install --name <n> <options>` does, as root:

| Path                                     | Content                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/systemd/system/<adapter>@.service` | template unit: `Type=simple`, `EnvironmentFile=-/etc/mqtt-interfaces/broker.env`, `EnvironmentFile=/etc/<adapter>/%i.env`, `Environment=<PREFIX>_NAME=%i`, `ExecStart=<node> <index.js>`, `Restart=always`, `User=<adapter>`, `StateDirectory=<adapter>/%i`, `SyslogIdentifier=<adapter>@%i`, hardening (`NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome`, `PrivateTmp`), plus `serviceExtra` |
| `/etc/<adapter>/<name>.env`              | the given options as `<PREFIX>_*` lines, `0640 root:<adapter>`; existing file backed up to `.bak`                                                                                                                                                                                                                                                                                                   |
| `/var/lib/<adapter>/<name>/`             | state directory, owned by the service user; `STATE_DIRECTORY` in the environment                                                                                                                                                                                                                                                                                                                    |
| system user `<adapter>`                  | `--system --no-create-home --shell /usr/sbin/nologin`, shared by all instances                                                                                                                                                                                                                                                                                                                      |

`--uninstall --name <n>` stops, disables and removes the instance and its env file; the template
unit goes when the last instance is gone; the state directory is kept. `Restart=always` is what
makes `maintenance/set/restart` (a clean `exit 0`) come back.

Adapter-specific installer work goes into `beforeStart` (e.g. lgtv2mqtt copies the TV pairing key
into the state directory, alexa-remote-mqtt the login cookie) — never into a second script. If an
option must not end up in the env file (because the unit sets it itself), pass `envOptions`.

### 5. index.js — the adapter

```js
#!/usr/bin/env node
import {createAdapter, clampInt, toBoolean} from 'mqtt-interfaces-core';
import config from './config.js';
import pkg from './package.json' with {type: 'json'};
import {handle as handleInstall} from './lib/install.js';
import {discoveryModel} from './lib/hadiscovery.js';

handleInstall(config); // --install / --uninstall never reach the rest

const adapter = createAdapter({
  pkg,
  config,
  deviceLabel: 'xyz', // how the device is called in log lines
  info: () => ({address: config.address}), // extra fields for <name>/info
  discovery: ({get}) => discoveryModel({name: config.name, model: get('model'), jsonPayloads: config.jsonPayloads}),
  discoveryTriggers: ['model'], // status items whose change re-publishes discovery
  onSet: handleSet, // <name>/set/<parts...>
  onMqttConnect: ({reconnect}) => {}, // after subscriptions and status re-publish
  onShutdown: () => device.close(), // SIGINT/SIGTERM/restart: disconnect the device
});
const {log, pubStatus, clearStatus, setDeviceConnected} = adapter;

async function handleSet(parts, value) {
  switch (parts[0]) {
    case 'volume':
      return device.setVolume(clampInt(value, 0, 100));
    case 'power':
      return device.setPower(toBoolean(value));
    default:
      throw new Error('unknown item ' + parts.join('/')); // → logged at warn
  }
}

const device = connect(config.address);
device.on('connect', () => setDeviceConnected(true));
device.on('close', () => setDeviceConnected(false));
device.on('state', (s) => {
  pubStatus('volume', s.volume);
  pubStatus('power', s.power);
});

adapter.start();
```

`createAdapter()` options, in full:

| Option                            | Meaning                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkg`                             | your `package.json` (name, version, homepage)                                                                                                                                                                       |
| `config`                          | the `parseConfig()` result                                                                                                                                                                                          |
| `log`                             | logger override (default `createLogger` with the env prefix and `--verbosity`)                                                                                                                                      |
| `deviceLabel`                     | name of the device in log lines (`'tv'`, `'cul'`)                                                                                                                                                                   |
| `info`                            | object or function → extra fields of the retained `<name>/info`                                                                                                                                                     |
| `discovery`                       | `({get, config}) → device block \| device block[] \| null` — see §7                                                                                                                                                 |
| `discoveryTriggers`               | status items whose change re-publishes discovery (coalesced by `discoveryDelay`, default 1 s)                                                                                                                       |
| `onSet(parts, value, topic, raw)` | handles `<name>/set/<parts…>`; `value` is the parsed payload (plain or `{val}`), return a promise; throw/reject → `warn` log                                                                                        |
| `subscriptions`                   | `{pattern: handler}` — an adapter's own topics under `<name>/` besides `set/#` (`{'paramset/#': …, 'rpc/+/+/+': …}`); MQTT wildcards, handler called like `onSet` with the levels the wildcards captured as `parts` |
| `onMqttConnect({reconnect})`      | after every (re)connect once subscriptions are done and status is re-published                                                                                                                                      |
| `onShutdown()`                    | called on SIGINT/SIGTERM/`maintenance/set/restart` before `connected 0` is published; may return a promise (2 s budget)                                                                                             |

The object it returns: `log`, `name`, `topic(...parts)`, `get(item)`, `pubStatus(item, value, {retain, extra, ts, lc})`,
`clearStatus(item)`, `republishStatus()`, `publishInfo()`, `publishDiscovery({force})`,
`markDiscoveryDirty()`, `setDeviceConnected(bool)`, `publish(topic, payload, opts)` (raw, for
`<name>/raw`-style extras), `start()`, `shutdown(reason, exitCode)`, and the getters `mqtt`,
`mqttConnected`, `deviceConnected`, `shuttingDown`.

Lifecycle: `start()` connects to the broker (client id `<prefix><name>_<random>`, LWT
`<name>/connected 0`), publishes `connected` (1, or 2 once you called `setDeviceConnected(true)`)
and `info`, subscribes `<name>/set/#` and `<name>/maintenance/set/+`, publishes discovery, and
re-publishes all retained status items after a reconnect. Connect to your device independently of
the broker and keep reconnecting to it forever with a modest interval (10 s) — the adapter is a
daemon, an unreachable device is normal operation, not a reason to exit.

### 6. Items, topics, payloads — the conventions

- **`<name>/connected`** (retained): `0` LWT/shutdown, `1` broker connected but device not,
  `2` device connected. Call `setDeviceConnected()` on every transition; the core does the rest.
- **`<name>/status/<item>`** (retained): every state value. `item` is **snake_case**, may be
  nested (`<protocol>/<address>/<field>` for bridges, `bridge/devices` for bridge-level state),
  never contains `+`, `#` or empty levels. Values: booleans as `true`/`false`, numbers as numbers,
  everything else as strings or JSON objects/arrays. Payload is `{"val": …, "ts": <ms>, "lc": <ms>}`
  (`lc` = last change) unless the instance runs with `--no-json-payloads`; `pubStatus()` builds it.
- **Events** (a button press, a spoken command, a progress tick — things that have no "current
  value"): `pubStatus(item, v, {retain: false})`. They are not re-published after a reconnect but
  stay readable via `get()` for discovery.
- **`clearStatus(item)`** when an item disappears for good (a device that left a bridge): clears
  the retained payload.
- **Extra fields**: `pubStatus(item, v, {extra: {hm: {...}}})` adds an adapter's own meta data
  next to `val`/`ts`/`lc` in the JSON payload (`{val, ts, lc, hm}`; ignored with
  `--no-json-payloads`, never overrides the three). Values that carry a device-side time pass
  `{ts, lc}` (ms) instead of the adapter's clock.
- **Own topics** besides `set/#` (a command tree that is not a `set`, an RPC pass-through):
  `createAdapter({subscriptions: {'paramset/#': handler}})` subscribes `<name>/paramset/#` and
  dispatches like `onSet`. Keep them rare; `set/<item>` is the convention.
- **`<name>/set/<item>[/...]`**: commands. Accept plain payloads (`50`, `true`, `on`, text) and
  `{"val": …}`; use `toBoolean`, `clampInt`, `toVolume` for tolerant parsing. A `set` on an item
  should result in a `status` update from the device's feedback, not from echoing the command.
- **`<name>/info`** (retained): `name` (npm package), `version`, `spec`, `node`, `host`, `pid`,
  `started`, `maintenance`, plus your `info` extras (`tv`, `cul`, `mode`). Keep it small and static;
  it is not a status topic.
- **`<name>/maintenance/set/loglevel`** (`error|warn|info|debug`) and **`…/restart`** — provided by
  the core; `--no-maintenance` turns them off for untrusted brokers.
- **`<name>/maintenance/stats`** (retained, every `--stats-interval` seconds, default 60, `0` = off):
  `rss`, `heapUsed`, `heapTotal` (bytes), `cpu` (percent of one core over the interval), `eventLoopLag`
  (worst ms in the interval), `uptime` (s), `ts` — process stats for dashboards such as she's
  Instances tab. Provided by the core, nothing to do in the adapter.
- **Raw/protocol topics** (`<name>/raw`, `<name>/set/raw`) are opt-in (`--publish-raw`,
  `--raw-set`), never on by default: a raw transmitter is a security surface.
- Topic names are API: do not rename items outside a major release; document the migration table
  in the README when you do (alexa-remote-mqtt 2.0's README shows the pattern).

### 7. Home Assistant discovery — lib/hadiscovery.js

Device-based discovery (`<ha-prefix>/device/<id>/config`, HA 2024.4+), on by default. Keep the
builder pure and test it: items in, device block out.

```js
import {entity, discoveryId} from 'mqtt-interfaces-core';

export function discoveryModel({name, model, jsonPayloads}) {
  const id = discoveryId('xyz2mqtt', name); // xyz2mqtt_<name>, sanitised
  const e = (item, platform, label, more = {}) => entity({id, name, item, platform, label, jsonPayloads, ...more});
  return {
    device: {mf: 'ACME', ...(model && {mdl: model})}, // ids, name, sw and the origin block are added
    components: {
      volume: e('volume', 'number', 'Volume', {command: true, extra: {min: 0, max: 100}}),
      power: e('power', 'switch', 'Power', {command: true, extra: {pl_on: 'true', pl_off: 'false'}}),
      signal: e('signal', 'sensor', 'Signal', {category: 'diagnostic', extra: {unit_of_meas: 'dBm'}}),
    },
  };
}
```

- `entity()` sets `stat_t` (`<name>/status/<item>`), `val_tpl` (`{{ value_json.val }}` with JSON
  payloads), `cmd_t` (with `command: true`), `uniq_id` (`<id>_<item>`), `ic`, `ent_cat`; `extra`
  carries any other HA field in its abbreviated form (`pl_on`, `min`, `options`, `unit_of_meas`,
  `dev_cla`, …). Stateless platforms (`button`, `notify`) get no state topic.
- Availability comes from `<name>/connected` (`online` when ≥ 2; `availabilityMin: 1` for a device
  that is legitimately off while the bridge runs, e.g. a TV that wakes on LAN).
- **Bridges** (one adapter, many physical devices — cul2mqtt, alexa-remote-mqtt): return an
  **array** of device blocks, each with its own `id` (`discoveryId('xyz2mqtt', name) + '_' +
device`), `device.via_device` pointing at the bridge's id, and optionally its own
  `availability` array (bridge availability + a per-device `<name>/status/<dev>/online` topic).
  Devices missing from a later result get their retained announcement cleared.
- Re-publish when the model changes: list the items in `discoveryTriggers`, or call
  `markDiscoveryDirty()` + `publishDiscovery()` when items appear dynamically (debounce it).
- Entity names in `label` are what the user sees; keep them short and device-relative
  ("Volume", not "Living room TV volume" — HA prefixes the device name).

### 8. Logging

`adapter.log` is a `createLogger()` (levels `debug`/`info`/`warn`/`error`; journald format with
`<N>` priorities and no own timestamp when running under systemd; text with colours on a TTY;
`<PREFIX>_LOG_FORMAT=journal|text` overrides). Rules the fleet follows:

- `debug`: every raw exchange, prefixed `mqtt <` / `mqtt >` (the core) and `<device> <` /
  `<device> >` (you). Connection attempts.
- `info`: lifecycle — starting, connected, subscribed, discovery published, shutting down.
- `warn`: an unreachable or misbehaving device, a rejected `set`, a maintenance action. Outcomes,
  not attempts.
- `error`: only things that need a human (bad config, unrecoverable state). Never swallow device
  errors — log them once, dedupe repeats (log the first, then `debug` until it changes).

### 9. Tests, lint, CI, release

- `config.js` parses the command line at import time: a test that imports `OPTIONS` from it must
  satisfy mandatory options first (`process.env.XYZ2MQTT_ADDRESS = …` before a dynamic
  `await import('../config.js')`), or the import exits with "Missing required argument".
- `node --test`, files in `test/*.test.js`. Test the pure modules exhaustively (items, commands,
  discovery model, mapping) and the installer through its `deps`/`exec` hooks; keep the device
  transport out of unit tests. The core is tested the same way (`npm test` here, 60 tests).
- `npm run lint` = eslint (flat config, `@eslint/js` recommended + prettier) + `prettier --check`.
  Copy `eslint.config.js`, `.prettierrc` (4 spaces, single quotes, no bracket spacing, width 120;
  2 spaces for json/yml/md) and `.editorconfig` from this repo. Let a failing lint stop you.
- CI (`.github/workflows/ci.yml`): lint + test on Node 20/22/24 on push and PR.
- Release (`.github/workflows/release.yml`, copy from here with `.github/release-notes.js`):
  bump `version` in `package.json` + lockfile, add a `## x.y.z` section to `CHANGELOG.md`
  (`### Breaking` / `### Added` / `### Changed` / `### Fixed`), commit, `git tag vX.Y.Z`,
  `git push --tags`. The workflow lints, tests, publishes to npm with provenance (trusted
  publishing — configure the repo as a trusted publisher on npmjs.com once), builds and pushes the
  multi-arch Docker image to ghcr.io (see below) and creates the GitHub release with the CHANGELOG
  section plus the commits since the previous tag. Every adapter ships both: npm **and** an image.
  The core and other libraries are npm only — they have no `Dockerfile` and no `docker` job.
- Versioning: semver; renaming topics or options is a major; new items/options a minor; fixes a
  patch. Keep `engines.node` in sync with the core.

### 10. Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.js config.js ./
COPY lib/ ./lib/
ENV NODE_ENV=production \
    XYZ2MQTT_MQTT_URL=mqtt://localhost \
    XYZ2MQTT_NAME=xyz \
    XYZ2MQTT_VERBOSITY=info
USER node
ENTRYPOINT ["node", "index.js"]
```

Config only via environment; a state directory as a volume when the adapter persists anything
(`XYZ2MQTT_STATE_DIR=/data`, `VOLUME /data` — with `RUN mkdir /data && chown node:node /data`
before it, otherwise docker creates the mount point root-owned and the `node` user cannot write);
`--restart unless-stopped` so `maintenance/set/restart` comes back. Serial devices: `--device` +
`--group-add`. Host networking when the device protocol needs multicast, broadcast or callbacks.

Every adapter publishes its image to `ghcr.io/hobbyquaker/<repo>` — the packages show up on the
GitHub project page, no extra registry account, no rate limit for pulls. The release workflow does
it on every tag, for amd64, arm64 and armv7 (Raspberry Pi), from this job:

```yaml
permissions:
  contents: write
  packages: write # ghcr.io
  id-token: write

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag || github.ref }}
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}},value=${{ inputs.tag || github.ref_name }}
            type=semver,pattern={{major}}.{{minor}},value=${{ inputs.tag || github.ref_name }}
            type=raw,value=latest
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64,linux/arm/v7
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

`GITHUB_TOKEN` is enough — no secret to configure. The `github-release` job needs
`[npm, docker]`, so a failed image build fails the release. The first push creates the package
as private: make it public once under _Package settings → Change visibility_, and link it to the
repository. Tags are `x.y.z`, `x.y` and `latest`; qemu makes the arm builds slow but keeps the
workflow to a single runner. Document the `docker run` line in the README next to the npm and
systemd install.

### 11. Development deploys

`deploy.sh` (take cul2mqtt's) runs the tests, `npm pack`s the adapter — and every `file:../…`
dependency, so you can develop against an unreleased sibling checkout of the core — copies the
tarballs to a host, installs into `/usr/local/lib/node_modules/<adapter>` and restarts the
`<adapter>@*` units. she marks such installs as _manual_ and asks before replacing them with the
npm version.

### 12. Checklist before the first release

- [ ] `npm run lint`, `npm test` green; CI workflow in place.
- [ ] README: install (`npm install -g`, `--install`, Docker), options table, topics with payload
      examples, Home Assistant section, `--config-schema` mention; CHANGELOG started.
- [ ] `Dockerfile` + `.dockerignore` present, the release workflow has the `docker` job, and the
      ghcr package is public after the first tag.
- [ ] Every credential option has `secret: true`; every user-maintained file has `file: {…}` with a
      shipped example (and a schema when the format allows one).
- [ ] `mqttInterfaces` field in `package.json`; `files` lists everything the runtime and the
      management UI need.
- [ ] Defaults contain nothing personal; raw/transmit topics are opt-in.
- [ ] Runs as the unprivileged service user with the hardening the template unit applies
      (`ProtectHome`, `ProtectSystem=full`) — state goes to `STATE_DIRECTORY`, not `$HOME`.
- [ ] `maintenance/set/restart` brings the instance back (systemd) and the device reconnects on
      its own after an outage.
- [ ] Checked in she: the instance shows up, the config form renders every option sensibly,
      secrets are masked, the map file is editable, logs stream.

## Conventions implemented

| topic                             | retained | notes                                                                                          |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `<name>/connected`                | yes      | `0` LWT/shutdown, `1` mqtt only, `2` mqtt + device                                             |
| `<name>/status/<item>`            | yes      | `{val, ts, lc}` JSON (+ adapter extras), or plain value with `--no-json-payloads`              |
| `<name>/set/<item>[/...]`         | —        | plain value or `{"val": ...}`; handled by the adapter's `onSet`                                |
| `<name>/info`                     | yes      | `name, version, spec, node, host, pid, started, maintenance, ...`                              |
| `<name>/maintenance/set/loglevel` | —        | `error`/`warn`/`info`/`debug`; `--no-maintenance` disables                                     |
| `<name>/maintenance/set/restart`  | —        | graceful shutdown + exit 0; the supervisor restarts the process                                |
| `<name>/maintenance/stats`        | yes      | `rss, heapUsed, heapTotal, cpu, eventLoopLag, uptime, ts` every `--stats-interval` s (0 = off) |
| `<ha-prefix>/device/<id>/config`  | yes      | HA device discovery, on by default; `--no-ha-discovery` clears it                              |

`discovery()` returns one device block, or an array of them for a bridge that sees several physical
devices (one `config` topic per device, `device.via_device` pointing at the bridge; devices missing
from a later result are cleared). A device block may carry its own `availability` array (instead of
the default `<name>/connected` entry) so that one device of a bridge can be shown as unavailable
while the bridge itself is fine; with more than one entry `avty_mode: 'all'` is added.

`pubStatus(item, value, {retain: false})` publishes an event (a spoken command, a progress tick):
it is not re-published after an mqtt reconnect, but the value stays readable via `get()`.
`clearStatus(item)` forgets an item and clears its retained payload.

Shared CLI options: `--mqtt-url/-u/--url`, `--mqtt-username`, `--mqtt-password`,
`--mqtt-client-id-prefix`, `--mqtt-tls-ca`, `--name/-n`, `--json-payloads`, `--ha-discovery`,
`--ha-prefix`, `--maintenance`, `--stats-interval`, `--verbosity/-v`, `--install`, `--uninstall`,
`--config-schema`. All of them also as `<ADAPTER>_<OPTION>` environment variables; `MQTT_URL`, `MQTT_USERNAME`,
`MQTT_PASSWORD`, `MQTT_TLS_CA` unprefixed as fallback (the client id prefix is per instance).

## API

| Export (from `mqtt-interfaces-core`)                                                                                               | Purpose                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAdapter(opts)`                                                                                                              | the façade — see [§5](#5-indexjs--the-adapter)                                                                                                     |
| `matchTopic(pattern, levels)`                                                                                                      | the wildcard matcher behind `subscriptions` (`+`, trailing `#`) → captured levels or `null`                                                        |
| `parseConfig({pkg, options, defaults, examples, epilog, check, scriptName, envPrefix})`                                            | CLI + env config, `--config-schema`                                                                                                                |
| `configSchema({pkg, envPrefix, options, defaults})`                                                                                | the JSON Schema without parsing (tests)                                                                                                            |
| `SHARED_OPTIONS`, `SHARED_ENV`, `applySharedEnv(env, prefix)`                                                                      | the canonical option set / broker env fallback                                                                                                     |
| `createInstaller({service, envPrefix, description, documentation, envOptions, environment, serviceExtra, beforeStart})`            | systemd template unit installer; returns `{unitFile, envFile, unitName, installService, uninstallService, handle, UNIT_PATH, CONF_DIR, STATE_DIR}` |
| `envVarName(option, prefix)`, `instanceName(name)`                                                                                 | helpers of the installer                                                                                                                           |
| `createLogger({envPrefix, format, color, level, write})`, `detectFormat()`, `LEVELS`                                               | logging                                                                                                                                            |
| `parsePayload(raw)`, `toBoolean(v)`, `clampInt(v, min, max)`, `toVolume(v)`, `StatusTracker`                                       | payload helpers (`StatusTracker`: `update`, `get`, `payload`, `isRetained`, `delete`)                                                              |
| `entity({...})`, `devicePayload({...})`, `availability(name, min)`, `discoveryId(adapter, instance)`, `discoveryTopic(prefix, id)` | Home Assistant discovery                                                                                                                           |
| `SPEC_VERSION`                                                                                                                     | `'2.0'`                                                                                                                                            |

## Management UIs: she

There is no standalone fleet manager: [she](https://github.com/hobbyquaker/she) (Services page,
optional) manages instances of adapters built on this core — inventory from `<name>/info` and
`<name>/connected`, restart and log level over the maintenance topics, and, via the systemd
installer layout, config forms from `--config-schema`, install/uninstall, updates, file editing
and per-instance broker credentials on the host. Everything it needs is part of the convention
described above; the specifics:

- **Catalog membership** is simply _depending on `mqtt-interfaces-core`_: she lists the packages
  of the npm publishers the user trusts (`services.trustedPublishers`, default the fleet's author)
  whose latest version depends on the core. No keyword, no registration. The `mqttInterfaces`
  field is optional metadata for the catalog (`needs`, `serviceExtra`).
- **Config forms** come from `--config-schema`: `x-env` maps a property to its env variable,
  `x-secret` masks it, `x-file` makes it editable in a Monaco editor (JSON validated against the
  shipped schema, YAML linted) with "create from example".
- **Host layout** she relies on: the template unit with `EnvironmentFile=/etc/<adapter>/%i.env`,
  `/etc/<adapter>/<name>.env`, `/var/lib/<adapter>/<name>/`, the wrapper or symlink
  `/usr/local/bin/<adapter>`. she only reads and writes inside the two directories.
- **Broker credentials**: she can write its own broker settings into an instance's env file, or
  create a dedicated Mosquitto dynsec identity per instance with an ACL limited to `<name>/#` and
  `homeassistant/#` — which is exactly what the conventions above make an adapter need.

## License

MIT © Sebastian Raff
