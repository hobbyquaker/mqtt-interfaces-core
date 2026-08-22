# Changelog

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
