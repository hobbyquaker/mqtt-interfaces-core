# Changelog

## 0.11.0

Discovery for adapters whose hardware is not on the network at all, prompted by ecoflow2mqtt.

### Added

- **`cloud` hint** — `{list({timeout})}` returning `[{id, name, model, …}]`, for a device that can
  only be found by asking its vendor. An EcoFlow inverter opens an outbound connection to
  EcoFlow's broker and speaks to nothing else, so every scanning method finds precisely nothing
  and the thing to configure is a serial number from the app; listing the account's devices is
  the only discovery there is. Entries become candidates keyed by `id`, with source `cloud`.
- `discoveryKinds()` returns `'cloud'`, so `x-discover` in `--config-schema` carries it and a
  management UI can offer the right affordance (she I13). A UI that does not know the value
  should still treat the property as discovery-capable.
- **`hint.needs`** and `discoveryNeeds(hint)` — option names `--discover` must keep demanding.
  `--discover` drops mandatory options, because the address it is about to look for must not be
  required to look for it; a cloud hint inverts that for its credentials, since without them
  there is no account to list and the missing option would surface as an api error much further
  down. The option the scan _fills_ is never among them.

### Changed

- A cloud `list()` failure **propagates** instead of being swallowed the way a failed SSDP search
  is. A network method that finds nothing is a result; a cloud method that fails is a wrong
  password or a moved endpoint, and reporting that as an empty network is what sent the last such
  bug hunting in the wrong place.
- `runDiscovery()` catches that failure, logs it and exits non-zero, rather than letting an
  unhandled rejection print a stack trace. Network hints are unaffected — they still cannot fail.
- `cloud: true` declares the kind without a callable, for the common case where the hint cannot
  be built until the config is parsed (`parseConfig` needs the shape; only `discover()` needs the
  function). A cloud spec without a `list` is skipped rather than crashing the scan.

## 0.10.0

Discovery for bridges, prompted by govee2mqtt: its LAN scan could not be expressed with what
0.9.0 offered.

### Added

- `udpProbe({bindPort})` and the `bindPort` key on a `udp` hint: bind the probe socket to a fixed
  local port. Most devices answer to the port the probe came from; some ignore it and answer to a
  fixed one, so an ephemeral socket hears nothing at all. Govee's LAN API is that case — the
  `scan` goes to 4001 and every device replies to 4002. The socket sets `reuseAddr`, so the port
  can usually be shared with a running instance of the same adapter; where a stack refuses, the
  probe is logged as failed and the other methods carry on. Default 0 (ephemeral) — unchanged for
  every existing hint.
- `autoAddresses(hint, options)`: the counterpart of `autoAddress` for a bridge whose address
  option is a list. One instance talks to every device it finds, so several hits are the normal
  outcome rather than the refusal `autoAddress` makes of them; none is still an error, because an
  empty list starts a bridge with nothing to bridge. Same name preference — the verified `fqdn`
  when dns knows the device, the address otherwise, and `--discover-ip` pins the address.

### Changed

- `x-discover` may now sit on an `array` property. The property's own `type` in `--config-schema`
  is what tells a management UI whether it is filling in one device or all of them, so no new
  marker was needed (she I13).

## 0.9.0

### Added

- **Device discovery** (B-2), `lib/discovery.js`: the scanning mechanics every adapter would
  otherwise repeat — SSDP M-SEARCH, mDNS/DNS-SD browse, UDP broadcast probes (the
  [hm-discover](https://github.com/hobbyquaker/hm-discover) pattern), subnet TCP sweeps and an
  ARP/OUI lookup — driven by a declarative hint plus an optional `probe(address)`. Candidates are
  merged per address, the declared `ports` are probed on each of them, and every scan is rate
  limited and time bounded. No dependencies: the protocols are spoken directly.
- `parseConfig({discovery: true})` adds `--discover`, `--discover-json` and `--discover-timeout`
  (meta options, never part of an instance configuration). `--discover` is exempt from mandatory
  options — the address it goes looking for must not be required to run it.
- `--discover-address` (repeatable) for devices a router away, which no broadcast and no
  multicast reaches: an address (`172.16.24.145`) is probed _and_ becomes a candidate in its own
  right, confirmed by the declared ports; a range (`172.16.20.0/24`) is swept for them. Probes
  otherwise go to the method's own group/broadcast address plus the broadcast address of every
  local subnet — `255.255.255.255` alone does not reliably leave the host.
- `mdnsQuery` listens on the mDNS group (port 5353, shared via `reuseAddr`) next to the socket
  that sent the query. An answer that came through an mDNS reflector — avahi with
  `enable-reflector`, bridging two VLANs — arrives as multicast there and never as unicast to the
  query's source port, so without the second socket every reflected device stays invisible. The
  browse falls back to the sending socket alone when 5353 cannot be shared.
- `serial` hint: USB adapters from `/dev/serial/by-id`, filtered by `contains` (all words,
  case-insensitive) or `match` (regexp or predicate). The candidate's address is the stable by-id
  path — the one worth putting in a config, since the `/dev/ttyACM0` it points at can swap places
  with another stick's — and the resolved device node comes along as `device`. Serial candidates
  are exempt from `ports` and the sweep: being plugged in is the proof. `/dev/cu.usb*` on macOS.
- **Names**: every network candidate carries the names it answers to, verified by a round trip
  (reverse the address, resolve each name back, keep it only when the address is among the
  answers) — `fqdn` when the qualified name checks out, `hostname` when the short label does.
  `address` is never replaced, so a consumer can offer all three (she I13). `--address auto` takes
  the `fqdn` when there is one, since it outlives a dhcp lease; `--discover-ip` pins the address.
  The short form is offered but never preferred: it resolves through the search list of whoever
  asks. `.local` is skipped — it verifies on a host with mDNS resolution and fails in a container
  on the same host.
- **`x-discover`** in `--config-schema`: the property flagged `discover: true` in its option
  definition is marked with the kind of scan the adapter's hint asks for (`"network"`, `"serial"`,
  or both, derived by the core). A schema with such a property is a discovery-capable adapter —
  what she's Add-instance flow keys off (she I13). Pass the hint to `parseConfig` as `discovery`
  instead of `true` to get it.
- `parseCidr`, `localBroadcasts`, `listSerialPorts`, `serialMatches`, `resolveNames`,
  `discoveryKinds` exported.

### Fixed

- SSDP builds one M-SEARCH per target, with `HOST` naming that target. Sending to several targets
  interpolated the whole list into the header (`HOST: 239.255.255.250,172.16.23.255:1900`), which
  every device on the link quietly ignored — the search found nothing while a single-target search
  worked.
- `ssdpSearch` and `mdnsQuery` set `SO_BROADCAST` before sending. Without it a subnet-broadcast
  target fails with EACCES, and that failure is not local to the target: it surfaces on the socket
  and takes the queued datagrams with it.
- A send that a target rejects no longer ends the scan: each datagram carries its own callback, so
  one unreachable or forbidden address cannot silence the others.
- `runDiscovery({hint, config, log})` for `--discover`, `autoAddress(hint, {config, log})` for
  `--address auto`
  (refuses to guess when none or several devices answer; with `config` it honours
  `--discover-timeout` and `--discover-address`), `discover()` / `discoverOne()`, and the
  pieces on their own: `ssdpSearch`, `mdnsQuery`, `udpProbe`, `tcpProbe`, `arpTable`,
  `localSubnets`, `subnetHosts`, `pool`.

## 0.8.1

### Changed

- README: every adapter publishes a multi-arch Docker image to `ghcr.io/hobbyquaker/<repo>` on
  every tag — the `docker` job for `release.yml`, `.dockerignore` in the project skeleton, the
  root-owned `/data` pitfall (`RUN mkdir /data && chown node:node /data`) and a checklist item for
  the ghcr package. Documentation only, the core itself stays npm-only.

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
