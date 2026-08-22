# mqtt-interfaces-core

Core library for writing `xyz2mqtt` interfaces ("adapters") in Node.js that follow the
[mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome) convention (spec 2.x).
It absorbs the ~80% every adapter repeats so an adapter is left with its device protocol and
an item table.

**Status: 0.x — API may still change while the first adapters (lgtv2mqtt 3.0, lgsb2mqtt 2.0)
are ported.** See [ROADMAP.md](ROADMAP.md).

## What you get

- **`createAdapter()`** — MQTT connection with LWT, `<name>/connected` `0`/`1`/`2`, retained
  `status/<item>` (plain or `{val, ts, lc}` with `--json-payloads`), `set/<item>` dispatch with
  plain and `{val}` payloads, status re-publish after reconnect, `<name>/info`,
  `maintenance/set/loglevel` + `restart`, Home Assistant device discovery (re)publishing,
  graceful shutdown on SIGINT/SIGTERM.
- **`parseConfig()`** — yargs CLI with the canonical shared option set plus your own options,
  `<ADAPTER>_*` env vars, unprefixed `MQTT_URL`/`MQTT_USERNAME`/`MQTT_PASSWORD`/... fallback,
  `--config-schema` (JSON Schema for the fleet manager).
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
| `<name>/status/<item>`            | yes      | plain value, or `{val, ts, lc}` with `--json-payloads`            |
| `<name>/set/<item>[/...]`         | —        | plain value or `{"val": ...}`; handled by the adapter's `onSet`   |
| `<name>/info`                     | yes      | `name, version, spec, node, host, pid, started, maintenance, ...` |
| `<name>/maintenance/set/loglevel` | —        | `error`/`warn`/`info`/`debug`; `--no-maintenance` disables        |
| `<name>/maintenance/set/restart`  | —        | graceful shutdown + exit 0; the supervisor restarts the process   |
| `<ha-prefix>/device/<id>/config`  | yes      | HA device discovery, on by default; `--no-ha-discovery` clears it |

Shared CLI options: `--mqtt-url/-u/--url`, `--mqtt-username`, `--mqtt-password`,
`--mqtt-client-id-prefix`, `--mqtt-tls-ca`, `--name/-n`, `--json-payloads`, `--ha-discovery`,
`--ha-prefix`, `--maintenance`, `--verbosity/-v`, `--install`, `--uninstall`, `--config-schema`.
All of them also as `<ADAPTER>_<OPTION>` environment variables.

## License

MIT © Sebastian Raff
