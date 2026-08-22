# Changelog

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
