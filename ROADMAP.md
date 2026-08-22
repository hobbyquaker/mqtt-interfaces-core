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

## Scope (Phase 2 of the master roadmap)

- [ ] **MQTT client wrapper**: connect with LWT, `connected` 0/1/2 lifecycle,
      reconnect, graceful shutdown (SIGINT/SIGTERM → `connected 0`, disconnect).
- [ ] **pub/sub helpers** implementing the retain rules (persistent state
      retained, events not) and plain-vs-`{val, ts, lc}` payloads
      (`--json-payloads`, D-3); incoming `set` accepts plain and `{val}`.
- [ ] **Config loader**: yargs-based CLI + `<ADAPTER>_*` env vars, precedence
      CLI > env > defaults, no config file (D-7); canonical option set
      (`--mqtt-url`/`-u`/`--url`, `--name`, `--verbosity`, `--json-payloads`,
      `--ha-discovery`, `--ha-prefix`, `--publish-raw`, `--no-maintenance`, …);
      shared broker variables `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`,
      `MQTT_CLIENT_ID_PREFIX`, `MQTT_TLS_CA` as fallback (B-3); emits a JSON
      Schema of the options for the fleet manager.
- [ ] **Logger** (replaces yalm): levels, `mqtt >`/`mqtt <` and
      `<device> >`/`<device> <` prefixes, journald detection (`JOURNAL_STREAM`
      → `<N>` priority prefixes, no own timestamp), `<ADAPTER>_LOG_FORMAT`
      override, runtime level change. Severity rules from the Phase 1 logging
      section (unreachable device = `warn`, `error` only for things needing a
      human; never swallow device errors; dedupe repeated connection errors;
      attempts at `debug`, outcomes at `warn`).
- [ ] **Introspection**: `<name>/info` retained JSON (adapter, version, node,
      uptime, host) and maintenance topics `maintenance/set/loglevel`,
      `maintenance/set/restart` (D-9, OQ-18: `process.exit(0)` + supervisor).
- [ ] **Home Assistant discovery publisher**: device-based
      (`homeassistant/device/<id>/config`), on by default (D-5),
      `--no-ha-discovery`, clear option, availability via `<name>/connected`
      with `payload_available: "2"`; pure builder from an adapter-supplied
      entity map (model: lgsb2mqtt `lib/hadiscovery.js`). Validation against
      HA's schema in CI — approach to decide here (B-8).
- [ ] **Device discovery** (B-2): the scanning mechanics exactly once —
      mDNS/SSDP listeners, subnet TCP probes, OUI lookup, rate limiting,
      timeouts — driven by the adapter's declarative hint and `probe(ip)`;
      provides `--discover [--json] [--timeout]` and `--address auto`
      (refuses to start on multiple matches).
- [ ] **systemd `--install`/`--uninstall`**: template unit
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

1. Spec 2.x draft exists in the umbrella repo (Phase 1) — the lib follows it,
   not the other way round.
2. Extract config loader, MQTT wrapper, payload helpers, logger from
   lgsb2mqtt/lgtv2mqtt; publish 0.x.
3. Rewrite **lgsb2mqtt** on top of it as the reference adapter, then
   lgtv2mqtt (Phase 3 order after that by usage/value).
4. HA discovery publisher + CI validation (B-8).
5. Device discovery module with lgsb2mqtt (`_googlecast._tcp` + port 9741)
   and lgtv2mqtt (SSDP webOS ST) as the two pilots (B-2).
6. `--install` module, shared tooling package.

## Open questions (local)

- Single package or `mqtt-interfaces-core` + separate `eslint-config`?
  Start single; split only on real pressure (D-8).
- CI validation of HA discovery payloads: JSON Schema vs. HA container
  (B-8).
