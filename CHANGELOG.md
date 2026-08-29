# Changelog

## 0.8.0

### Added

- `<name>/maintenance/stats` (retained): `rss`, `heapUsed`, `heapTotal`, `cpu` (percent of one core
  over the interval), `eventLoopLag` (worst ms), `uptime`, `ts` — published every `--stats-interval`
  seconds (default 60, `0` disables). she shows memory and CPU per instance from it; hosts with the
  helper fall back to systemd's accounting for adapters on older cores.

## 0.7.0

Needed by hm2mqtt 3.0 (a drop-in replacement for a Node-RED flow: meta-data block in every
payload, command topics besides `set/`).

### Added

- `pubStatus(item, value, {extra})`: additional fields in the `{val, ts, lc}` JSON payload (e.g.
  `hm: {...}`); kept by `StatusTracker` and re-published after a reconnect, never overriding
  `val`/`ts`/`lc`, ignored with `--no-json-payloads`.
- `pubStatus(item, value, {ts, lc})`: device-side timestamps (ms) instead of the adapter's clock.
- `createAdapter({subscriptions: {'paramset/#': handler, 'rpc/+/+/+': handler}})`: further topics
  under `<name>/` are subscribed on every (re)connect and dispatched like `onSet`, with the levels
  captured by the wildcards as `parts`. `matchTopic()` is exported.

## 0.6.1

### Fixed

- `--uninstall --name <n>` no longer fails on an adapter's mandatory options (`demandOption`,
  e.g. a device address): uninstalling needs only the instance name.

## 0.6.0

### Added

- `file: {format, example, schema, describe}` on an option definition → `"x-file": {…}` in the
  `--config-schema` output: the option holds the path of a file the user maintains (a map of
  friendly names, a pairing key). Management UIs (she's Services page) can offer an editor with
  validation and "create from example" for it.

## 0.5.0

### Breaking

- The unprefixed `MQTT_CLIENT_ID_PREFIX` is no longer read as a shared fallback: a client id
  prefix is specific to an adapter instance, not to a host. Use
  `<ADAPTER>_MQTT_CLIENT_ID_PREFIX` (or `--mqtt-client-id-prefix`) per instance. The shared
  `/etc/mqtt-interfaces/broker.env` holds `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` and
  `MQTT_TLS_CA`.

## 0.4.0

Companion release for she's Services page (management of adapter instances from she instead of a
standalone fleet manager).

### Added

- `secret: true` on an option definition → `"x-secret": true` in the `--config-schema` output, so
  management UIs know what to mask. `--mqtt-password` is marked.
- The schema's `x-adapter` echoes the package's `mqttInterfaces` field.
- README: the npm keyword `mqtt-interfaces` and the `mqttInterfaces` package.json field
  (`spec`, `envPrefix`, `needs`, `serviceExtra`) that make an adapter discoverable for catalogs.

## 0.3.0

Needed by the first multi-device bridge on the core (alexa-remote-mqtt 2.0).

### Added

- `devicePayload()` / a `discovery()` device block accept `availability` (and `availabilityMode`):
  the default `<name>/connected` entry can be replaced, e.g. by the bridge availability plus a
  per-device online topic, so a single device behind a bridge can be unavailable on its own.
  `avty_mode: 'all'` is added automatically for more than one entry.
- `adapter.clearStatus(item)`: forget an item and clear its retained payload (a device that
  disappeared).
- `StatusTracker.isRetained(item)`.

### Fixed

- Items published with `{retain: false}` are no longer re-published **retained** after an mqtt
  reconnect: `StatusTracker` remembers the retain flag per item and `republishStatus()` skips
  events. Their last value stays available for `get()` and discovery.

## 0.2.0

### Breaking

- `--json-payloads` defaults to **true**: status payloads are `{val, ts, lc}` JSON unless
  `--no-json-payloads` is given (mqtt-smarthome spec 2.0, master roadmap D-3 revised).
  `entity()` adds the `value_template` by default accordingly.

### Added

- `createAdapter({discovery})` may return an **array** of device blocks: one Home Assistant device
  per physical device behind a bridge (cul2mqtt: one per RF sensor / thermostat, linked to the CUL
  via `device.via_device`). Each gets its own `<ha-prefix>/device/<id>/config`; devices missing
  from a later result are cleared. A single object keeps working as before.
- `createInstaller({serviceExtra: [...]})`: extra `[Service]` lines in the template unit, e.g.
  `SupplementaryGroups=dialout` for adapters that need a serial port (cul2mqtt).

## 0.1.1

- `createAdapter()`: trigger-driven Home Assistant discovery re-publishes are coalesced
  (`discoveryDelay`, default 1 s) — device info arriving item by item (`model`, `firmware`, `mac`,
  lists) no longer publishes the retained payload once per item.

## 0.1.0

First release, extracted from lgtv2mqtt 2.0: `createAdapter()` façade, `parseConfig()` with JSON
Schema export and shared `MQTT_*` env fallback, journald-aware logger, payload helpers, Home
Assistant device discovery scaffold, systemd installer.
