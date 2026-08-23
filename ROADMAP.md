# mqtt-interfaces-core — roadmap

Core library for writing `xyz2mqtt` interfaces ("adapters") in Node.js that
follow the [mqtt-smarthome](https://github.com/mqtt-smarthome/mqtt-smarthome)
convention. It absorbs the ~80% every adapter repeats so an adapter is left
with its device protocol and an item table.

This file covers only the core lib. The overall plan (phases, decisions
D-1…D-13, open questions, backlog B-1…B-8) is the master roadmap in
[mqtt-interfaces](https://github.com/hobbyquaker/mqtt-interfaces/blob/main/ROADMAP.md);
the convention itself is specified in
[mqtt-smarthome/SPEC.md](https://github.com/mqtt-smarthome/mqtt-smarthome)
(to be written). References like D-8/B-2 point into the master roadmap.

## Positioning

- Implements a stated version of the mqtt-smarthome spec 2.x and says which
  (`SPEC.md` lives in the umbrella repo, not here — D-8, B-7).
- One possible implementation of the convention; other languages/libs are
  equally "mqtt-smarthome".
- Plain JavaScript, ESM, no TypeScript (D-4); minimal dependencies — runs on
  Raspberry-class machines; `engines: node >= 20`.
- npm package `mqtt-interfaces-core`, unscoped (OQ-15).

## Decisions (local)

| ID  | Decision                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | **Order flipped (2026-08-22)**: the core lib is extracted from lgtv2mqtt 2.0 (the most modern adapter: ESM, journald logger, tests); lgtv2mqtt 3.0 is the reference adapter, lgsb2mqtt 2.0 second. Supersedes the lgsb-first order of the master roadmap Phase 2.                              |
| C-2 | **API shape**: `createAdapter()` façade owning MQTT/connected/status/info/maintenance/discovery/shutdown; every module (`log`, `payload`, `config`, `hadiscovery`, `install`) also exported on its own.                                                                                        |
| C-3 | **`<name>/info` fields**: `name, version, spec, node, host, pid, started` (ISO; uptime is derivable), `maintenance` (bool) + adapter extras (e.g. `tv`).                                                                                                                                       |
| C-4 | **Config env handling** is done by the core, not yargs `.env()` (which only reads `process.env`): env values become typed defaults, so CLI > env > defaults holds and the unprefixed `MQTT_*` fallback works. `--config-schema` is handled before parsing so required options do not block it. |
| C-5 | **Restart semantics (OQ-18)**: `maintenance/set/restart` = graceful shutdown + `exit 0`; the template unit uses `Restart=always` (not `on-failure`) so systemd brings it back; Docker needs `--restart unless-stopped`.                                                                        |

## Scope (Phase 2 of the master roadmap)

- [x] **MQTT client wrapper**: connect with LWT, `connected` 0/1/2 lifecycle,
      reconnect, graceful shutdown (SIGINT/SIGTERM → `connected 0`, disconnect).
- [x] **pub/sub helpers** implementing the retain rules (persistent state
      retained, events not) and `{val, ts, lc}`-vs-plain payloads
      (JSON by default, `--no-json-payloads`; D-3 revised 2026-08-22); incoming `set` accepts plain and `{val}`.
- [x] **Config loader**: yargs-based CLI + `<ADAPTER>_*` env vars, precedence
      CLI > env > defaults, no config file (D-7); canonical option set
      (`--mqtt-url`/`-u`/`--url`, `--name`, `--verbosity`, `--json-payloads`,
      `--ha-discovery`, `--ha-prefix`, `--publish-raw`, `--no-maintenance`, …);
      shared broker variables `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`,
      `MQTT_CLIENT_ID_PREFIX`, `MQTT_TLS_CA` as fallback (B-3); emits a JSON
      Schema of the options (`x-env`, `x-secret`, `x-adapter`) for management UIs.
- [x] **Logger** (replaces yalm): levels, `mqtt >`/`mqtt <` and
      `<device> >`/`<device> <` prefixes, journald detection (`JOURNAL_STREAM`
      → `<N>` priority prefixes, no own timestamp), `<ADAPTER>_LOG_FORMAT`
      override, runtime level change. Severity rules from the Phase 1 logging
      section (unreachable device = `warn`, `error` only for things needing a
      human; never swallow device errors; dedupe repeated connection errors;
      attempts at `debug`, outcomes at `warn`).
- [x] **Introspection**: `<name>/info` retained JSON (adapter, version, node,
      uptime, host) and maintenance topics `maintenance/set/loglevel`,
      `maintenance/set/restart` (D-9, OQ-18: `process.exit(0)` + supervisor).
- [~] **Home Assistant discovery publisher** (scaffold + helpers done; CI validation open): device-based
  (`homeassistant/device/<id>/config`), on by default (D-5),
  `--no-ha-discovery`, clear option, one or many devices per adapter (bridges: `via_device`),
  availability via `<name>/connected`
  with `payload_available: "2"`; pure builder from an adapter-supplied
  entity map (model: lgsb2mqtt `lib/hadiscovery.js`). Validation against
  HA's schema in CI — approach to decide here (B-8).
- [ ] **Device discovery** (B-2): the scanning mechanics exactly once —
      mDNS/SSDP listeners, subnet TCP probes, OUI lookup, rate limiting,
      timeouts — driven by the adapter's declarative hint and `probe(ip)`;
      provides `--discover [--json] [--timeout]` and `--address auto`
      (refuses to start on multiple matches).
- [x] **systemd `--install`/`--uninstall`**: template unit
      `<adapter>@<name>`, `/etc/<adapter>/<name>.env`, system user,
      `SyslogIdentifier=<adapter>@%i`, `EnvironmentFile=-` for the shared
      broker env file (B-3); parameterised by adapter name (today duplicated
      in lgsb2mqtt/lgtv2mqtt `lib/install.js`).
- [ ] **Shared tooling**: eslint + prettier config export, GitHub workflow
      templates (lint/test on Node 20/22/24, release), Dockerfile template
      (multi-arch, env config).

## Pilot inventory — what gets extracted from where

| piece                                               | lgsb2mqtt                        | lgtv2mqtt        |
| --------------------------------------------------- | -------------------------------- | ---------------- |
| CLI + env config (yargs, `<ADAPTER>_*`)             | `config.js`                      | `config.js`      |
| `connected` 0/1/2 lifecycle, LWT, graceful shutdown | `index.js`                       | `index.js`       |
| incoming payload parsing (plain / `{val}`)          | `lib/payload.js`                 | `lib/payload.js` |
| `{val, ts, lc}` status tracking                     | `lib/payload.js` StatusTracker   | —                |
| HA device-based discovery builder                   | `lib/hadiscovery.js`             | —                |
| systemd `--install`/`--uninstall` template unit     | `lib/install.js`                 | `lib/install.js` |
| journald-aware logger                               | — (yalm)                         | `lib/log.js`     |
| lint/format/CI/release workflows                    | eslint+prettier, CI, release.yml | xo               |
| Dockerfile (node:22-alpine, env config)             | yes                              | yes              |

## Order of work

1. ~~Extract config loader, MQTT wrapper, payload helpers, logger, discovery
   scaffold and installer from lgtv2mqtt 2.0~~ — done 2026-08-22 (0.1.0, 49 unit
   tests), see C-1.
2. **lgtv2mqtt 3.0** on top of it as the reference adapter (same topics as 2.0 +
   maintenance topics); this is where the API gets its final shape. Publish
   core 0.1.0 to npm once 3.0 runs against the real TV.
3. **lgsb2mqtt 2.0** (ESM, drops yalm, gains info/maintenance for free), then the
   rest of the fleet by usage/value (Phase 3).
4. Spec 2.x in the umbrella repo is written _from_ what the core does (the
   lib and the two pilots are the living draft).
5. HA discovery publisher + CI validation (B-8).
6. Device discovery module with lgsb2mqtt (`_googlecast._tcp` + port 9741)
   and lgtv2mqtt (SSDP webOS ST) as the two pilots (B-2).
7. `--install` module, shared tooling package.

## 0.3.0 — needed by alexa-remote-mqtt 2.0 (done)

Specified in the [alexa-remote-mqtt ROADMAP](https://github.com/hobbyquaker/alexa-remote-mqtt/blob/master/ROADMAP.md)
§1.2 (G-1 … G-3); the first multi-device bridge on the core.

- [x] **G-1** `pubStatus(item, v, {retain: false})` items must not be re-published retained after
      an MQTT reconnect: `StatusTracker` remembers `retain` per item, `republishStatus()` skips
      non-retained items.
- [x] **G-2** discovery device block accepts `availability` (array, replaces the default
      `<name>/connected` entry; `availability_mode: 'all'` is added when there is more than one) —
      per-device availability for bridges.
- [x] **G-3** `adapter.clearStatus(item)`: empty retained publish + `status.delete()`.

## 0.4.0 — companion to she's Services page (done)

The fleet manager of the master roadmap is not built as a standalone app; she manages adapter
instances instead (design: [she/ROADMAP-SERVICES.md](https://github.com/hobbyquaker/she/blob/main/ROADMAP-SERVICES.md),
items I4–I8; decision SV-1 there). The core's side of it:

- [x] `secret: true` → `x-secret` in the schema (she SV-10).
- [x] `mqttInterfaces` package.json field echoed in `x-adapter`; README documents the field and
      the npm keyword `mqtt-interfaces` (she SV-11 — catalog by npm self-marking, no catalog file).
- [ ] Adapters: add keyword + field and mark their secrets (lgtv2mqtt, cul2mqtt, alexa-remote-mqtt,
      lgsb2mqtt) — one line each, next release of each.
- Nothing is published over MQTT for she's sake (schema stays CLI-only, she SV-6).

## Open questions (local)

- Single package or `mqtt-interfaces-core` + separate `eslint-config`?
  Start single; split only on real pressure (D-8).
- CI validation of HA discovery payloads: JSON Schema vs. HA container
  (B-8).
