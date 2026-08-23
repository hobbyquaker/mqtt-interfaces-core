# mqtt-interfaces-core

Core library for writing `xyz2mqtt` interfaces ("adapters") in Node.js that follow the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention (spec 2.x).
It absorbs the ~80% every adapter repeats so an adapter is left with its device protocol and
an item table.

**Status: 0.x — API may still change while the first adapters (lgtv2mqtt 3.0, lgsb2mqtt 2.0)
are ported.** See [ROADMAP.md](ROADMAP.md).

## What you get

- **`createAdapter()`** — MQTT connection with LWT, `<name>/connected` `0`/`1`/`2`, retained
  `status/<item>` (`{val, ts, lc}` JSON, or plain values with `--no-json-payloads`), `set/<item>` dispatch with
  plain and `{val}` payloads, status re-publish after reconnect, `<name>/info`,
  `maintenance/set/loglevel` + `restart`, Home Assistant device discovery (re)publishing,
  graceful shutdown on SIGINT/SIGTERM.
- **`parseConfig()`** — yargs CLI with the canonical shared option set plus your own options,
  `<ADAPTER>_*` env vars, unprefixed `MQTT_URL`/`MQTT_USERNAME`/`MQTT_PASSWORD`/... fallback,
  `--config-schema` (JSON Schema of all options, with `x-env` / `x-secret`, for management UIs).
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

## Conventions implemented

| topic                             | retained | notes                                                             |
| --------------------------------- | -------- | ----------------------------------------------------------------- |
| `<name>/connected`                | yes      | `0` LWT/shutdown, `1` mqtt only, `2` mqtt + device                |
| `<name>/status/<item>`            | yes      | `{val, ts, lc}` JSON, or plain value with `--no-json-payloads`    |
| `<name>/set/<item>[/...]`         | —        | plain value or `{"val": ...}`; handled by the adapter's `onSet`   |
| `<name>/info`                     | yes      | `name, version, spec, node, host, pid, started, maintenance, ...` |
| `<name>/maintenance/set/loglevel` | —        | `error`/`warn`/`info`/`debug`; `--no-maintenance` disables        |
| `<name>/maintenance/set/restart`  | —        | graceful shutdown + exit 0; the supervisor restarts the process   |
| `<ha-prefix>/device/<id>/config`  | yes      | HA device discovery, on by default; `--no-ha-discovery` clears it |

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
`--ha-prefix`, `--maintenance`, `--verbosity/-v`, `--install`, `--uninstall`, `--config-schema`.
All of them also as `<ADAPTER>_<OPTION>` environment variables.

## Management UIs and fleet membership

There is no standalone fleet manager: [she](https://github.com/hobbyquaker/she) (Services page,
optional) manages instances of adapters built on this core — inventory from `<name>/info` and
`<name>/connected`, restart and log level over the maintenance topics, and, via the systemd
installer layout, config editing, install/uninstall and updates on the host. Everything it needs is
part of the convention; an adapter has to do three things so that it works well there:

- **`--config-schema`** — comes for free from `parseConfig()`. Options that hold credentials get
  `secret: true` in their definition (`--mqtt-password` already has it); they appear as
  `"x-secret": true` in the schema and are masked in forms.
- **npm keyword `mqtt-interfaces`** in `package.json` — marks the package as an adapter on this
  convention so it shows up in adapter catalogs (npm registry search on the keyword).
- **`mqttInterfaces` field** in `package.json` — metadata a catalog needs before the package is
  installed:

  ```json
  "keywords": ["mqtt", "mqtt-smarthome", "mqtt-interfaces"],
  "mqttInterfaces": {
    "spec": "2.0",
    "envPrefix": "FOO2MQTT",
    "needs": ["serial"],
    "serviceExtra": ["SupplementaryGroups=dialout"]
  }
  ```

  `spec` — implemented mqtt-smarthome spec version; `envPrefix` — the `<ADAPTER>_` prefix
  (default: package name upper-cased, non-alphanumerics → `_`); `needs` — host prerequisites a UI
  should point out (`serial`, `bluetooth`, `usb`, `network-host`); `serviceExtra` — the extra
  `[Service]` lines the adapter passes to `createInstaller()`. The whole field is also echoed in
  the schema's `x-adapter`.

Whether a catalog offers to install a package is the catalog's decision (she gates it by a
trusted-publishers list) — the keyword only makes an adapter discoverable.

## License

MIT © Sebastian Raff
