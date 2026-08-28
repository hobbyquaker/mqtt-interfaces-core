/**
 * Device discovery (B-2): the scanning mechanics every adapter would otherwise repeat, written
 * exactly once — SSDP M-SEARCH, mDNS/DNS-SD browse, UDP broadcast probes, subnet TCP sweeps and
 * an ARP/OUI lookup — driven by a declarative hint plus an optional `probe(address)`.
 *
 * An adapter declares how its devices announce themselves and the core does the socket work,
 * the rate limiting, the timeouts and the merging:
 *
 *   export const DISCOVERY = {
 *       ssdp: {st: 'urn:lge-com:service:webos-second-screen:1'},   // lgtv2mqtt
 *       mdns: {service: '_googlecast._tcp'},                       // lgsb2mqtt
 *       udp: {port: 43439, payload: EQ3_PROBE, parse: parseEq3},   // homematic (hm-discover)
 *       ports: {ReGaHSS: 1999, 'BidCos-RF': 2001},                 // probed on every candidate
 *       oui: ['00:1a:22'],                                         // eQ-3, from the ARP table
 *       probe: async (address) => ({model: await readModel(address)}),
 *   };
 *
 * Every method contributes candidates; they are merged per address, the declared `ports` are
 * probed on each of them and `probe()` has the last word (returning null drops a candidate).
 *
 * The listeners are deliberately dependency-free: mDNS and SSDP are small enough to speak
 * directly, and an adapter on a Raspberry Pi should not pull a discovery stack per protocol.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';

export const DEFAULT_TIMEOUT = 5000;
export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;

/**
 * Hosts a single subnet sweep is willing to touch (a /20). Bigger subnets are skipped with a
 * warning: a sweep is bounded by `concurrency` connects of 1 s, so a /20 is already a minute.
 */
export const MAX_SWEEP_HOSTS = 4096;

const NO_LOG = {debug() {}, info() {}, warn() {}, error() {}};

export class DiscoveryError extends Error {
    constructor(message, extra = {}) {
        super(message);
        this.name = 'DiscoveryError';
        Object.assign(this, extra);
    }
}

/*
 * generic helpers
 */

/** Run `worker` over `items`, at most `concurrency` at a time (rate limiting for sweeps/probes). */
export async function pool(items, worker, concurrency = 32) {
    const list = [...items];
    const results = new Array(list.length);
    let next = 0;
    const runner = async () => {
        while (next < list.length) {
            const index = next++;
            results[index] = await worker(list[index], index);
        }
    };
    await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, list.length))}, runner));
    return results;
}

/**
 * Resolves after `ms`. Deliberately *not* unref'd: a scan is the only thing running while it
 * waits for answers, and an unref'd timer would let the event loop drain and the process exit
 * mid-scan.
 */
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** true when a TCP connection to address:port is accepted within `timeout` ms. */
export function tcpProbe(address, port, {timeout = 1000, connect = net.connect} = {}) {
    return new Promise((resolve) => {
        let socket;
        let done = false;
        const finish = (open) => {
            if (done) {
                return;
            }
            done = true;
            if (socket) {
                socket.destroy();
            }
            resolve(open);
        };
        try {
            socket = connect({host: address, port});
        } catch {
            resolve(false);
            return;
        }
        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

/*
 * addresses and subnets
 */

export function ipToInt(ip) {
    return String(ip)
        .split('.')
        .reduce((acc, part) => ((acc << 8) + (Number(part) & 0xff)) >>> 0, 0);
}

export function intToIp(value) {
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/** The IPv4 subnets of this host's non-internal interfaces. */
export function localSubnets({interfaces = os.networkInterfaces} = {}) {
    const subnets = [];
    for (const [name, entries] of Object.entries(interfaces() || {})) {
        for (const entry of entries || []) {
            const ipv4 = entry.family === 'IPv4' || entry.family === 4;
            if (!ipv4 || entry.internal || !entry.netmask) {
                continue;
            }
            const mask = ipToInt(entry.netmask);
            const network = (ipToInt(entry.address) & mask) >>> 0; // `&` is signed in JS
            const broadcast = (network | (~mask >>> 0)) >>> 0;
            subnets.push({
                interface: name,
                address: entry.address,
                netmask: entry.netmask,
                network: intToIp(network),
                broadcast: intToIp(broadcast),
                hosts: Math.max(0, broadcast - network - 1),
            });
        }
    }
    return subnets;
}

/** The broadcast addresses of this host's subnets — where a probe actually gets forwarded. */
export function localBroadcasts({interfaces = os.networkInterfaces} = {}) {
    return localSubnets({interfaces})
        .filter((subnet) => subnet.hosts > 0)
        .map((subnet) => subnet.broadcast);
}

/** Every host address of a subnet (without network and broadcast); empty when it is too big. */
export function subnetHosts(subnet, {maxHosts = MAX_SWEEP_HOSTS} = {}) {
    if (!subnet || subnet.hosts < 1 || subnet.hosts > maxHosts) {
        return [];
    }
    const first = ipToInt(subnet.network) + 1;
    return Array.from({length: subnet.hosts}, (_, index) => intToIp(first + index));
}

/*
 * SSDP
 */

/** Parse an SSDP response into lower-cased headers; null when it is not one. */
export function parseSsdp(message) {
    const lines = String(message).split(/\r?\n/);
    if (!/^(HTTP\/1\.1\s+200|NOTIFY\s)/i.test(lines[0] || '')) {
        return null;
    }
    const headers = {};
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) {
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
    }
    return headers;
}

/**
 * M-SEARCH for `st` and collect the unicast answers.
 * @returns {Promise<Array<{address: string, headers: object}>>}
 */
export async function ssdpSearch({
    st = 'ssdp:all',
    mx = 2,
    timeout = DEFAULT_TIMEOUT,
    address = SSDP_ADDRESS,
    port = SSDP_PORT,
    tries = 2,
    createSocket = () => dgram.createSocket({type: 'udp4', reuseAddr: true}),
} = {}) {
    const search = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: ${address}:${port}\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${st}\r\n\r\n`,
    );
    const targets = [].concat(address);
    const answers = [];
    const socket = createSocket();
    socket.on('message', (message, rinfo) => {
        const headers = parseSsdp(message);
        if (headers) {
            answers.push({address: rinfo.address, headers});
        }
    });
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(() => {
            socket.removeListener('error', reject);
            resolve();
        });
    });
    socket.on('error', () => {});
    try {
        for (let i = 0; i < tries; i++) {
            for (const target of targets) {
                socket.send(search, 0, search.length, port, target);
            }
            if (i + 1 < tries) {
                await delay(Math.min(300, timeout / (tries + 1)));
            }
        }
        await delay(timeout);
    } finally {
        socket.close();
    }
    return answers;
}

/*
 * mDNS / DNS-SD
 */

export const DNS_TYPE = {A: 1, PTR: 12, TXT: 16, SRV: 33};

export function encodeName(name) {
    const parts = String(name)
        .replace(/\.$/, '')
        .split('.')
        .filter((part) => part.length > 0);
    const chunks = [];
    for (const part of parts) {
        const label = Buffer.from(part, 'utf8');
        chunks.push(Buffer.from([label.length]), label);
    }
    chunks.push(Buffer.from([0]));
    return Buffer.concat(chunks);
}

/** Read a (possibly compressed) name; returns the name and the offset after it. */
export function readName(buffer, offset) {
    const labels = [];
    let after = offset;
    let jumped = false;
    for (let guard = 0; guard < 128 && offset < buffer.length; guard++) {
        const length = buffer[offset];
        if (length === 0) {
            offset += 1;
            if (!jumped) {
                after = offset;
            }
            break;
        }
        if ((length & 0xc0) === 0xc0) {
            if (offset + 1 >= buffer.length) {
                break;
            }
            const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
            if (!jumped) {
                after = offset + 2;
            }
            jumped = true;
            offset = pointer;
            continue;
        }
        labels.push(buffer.toString('utf8', offset + 1, offset + 1 + length));
        offset += 1 + length;
        if (!jumped) {
            after = offset;
        }
    }
    return [labels.join('.'), after];
}

/** A DNS-SD query for one service type; `unicast` sets the QU bit so the answer comes back to us. */
export function encodeQuery(name, {type = DNS_TYPE.PTR, unicast = true, id = 0} = {}) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(1, 4); // one question
    const question = encodeName(name);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(unicast ? 0x8001 : 0x0001, 2);
    return Buffer.concat([header, question, tail]);
}

function decodeRdata(type, buffer, offset, length) {
    switch (type) {
        case DNS_TYPE.A:
            return length === 4 ? Array.from(buffer.subarray(offset, offset + 4)).join('.') : null;
        case DNS_TYPE.PTR:
            return readName(buffer, offset)[0];
        case DNS_TYPE.SRV:
            return {
                priority: buffer.readUInt16BE(offset),
                weight: buffer.readUInt16BE(offset + 2),
                port: buffer.readUInt16BE(offset + 4),
                target: readName(buffer, offset + 6)[0],
            };
        case DNS_TYPE.TXT: {
            const txt = {};
            let cursor = offset;
            while (cursor < offset + length) {
                const size = buffer[cursor];
                const entry = buffer.toString('utf8', cursor + 1, cursor + 1 + size);
                const equals = entry.indexOf('=');
                if (equals > 0) {
                    txt[entry.slice(0, equals)] = entry.slice(equals + 1);
                } else if (entry) {
                    txt[entry] = true;
                }
                cursor += 1 + size;
            }
            return txt;
        }
        default:
            return null;
    }
}

/** All resource records of a DNS message (answers, authority, additional); [] when malformed. */
export function parseDnsMessage(buffer) {
    const records = [];
    try {
        const questions = buffer.readUInt16BE(4);
        const counts = [buffer.readUInt16BE(6), buffer.readUInt16BE(8), buffer.readUInt16BE(10)];
        let offset = 12;
        for (let i = 0; i < questions; i++) {
            offset = readName(buffer, offset)[1] + 4;
        }
        for (const count of counts) {
            for (let i = 0; i < count; i++) {
                const [name, afterName] = readName(buffer, offset);
                const type = buffer.readUInt16BE(afterName);
                const length = buffer.readUInt16BE(afterName + 8);
                records.push({name, type, data: decodeRdata(type, buffer, afterName + 10, length)});
                offset = afterName + 10 + length;
            }
        }
    } catch {
        return records;
    }
    return records;
}

/**
 * Browse one DNS-SD service type. The query goes to the mDNS group from an ephemeral port with
 * the unicast-response bit set: no membership on port 5353, so a resolver already running on the
 * host (avahi, mDNSResponder) is not disturbed.
 * @returns {Promise<Array<{address: string, instance: string, host: string, port: number, txt: object}>>}
 */
export async function mdnsQuery({
    service,
    timeout = DEFAULT_TIMEOUT,
    address = MDNS_ADDRESS,
    port = MDNS_PORT,
    tries = 2,
    createSocket = () => dgram.createSocket({type: 'udp4', reuseAddr: true}),
} = {}) {
    const name = /\.local$/.test(service) ? service : `${service}.local`;
    const targets = [].concat(address);
    const query = encodeQuery(name);
    const records = [];
    const senders = new Map();
    const socket = createSocket();
    socket.on('message', (message, rinfo) => {
        for (const record of parseDnsMessage(message)) {
            records.push(record);
            senders.set(record.name, rinfo.address);
        }
    });
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(() => {
            socket.removeListener('error', reject);
            resolve();
        });
    });
    socket.on('error', () => {});
    try {
        for (let i = 0; i < tries; i++) {
            for (const target of targets) {
                socket.send(query, 0, query.length, port, target);
            }
            if (i + 1 < tries) {
                await delay(Math.min(300, timeout / (tries + 1)));
            }
        }
        await delay(timeout);
    } finally {
        socket.close();
    }
    return assembleServices(records, name, senders);
}

/** PTR → SRV → A chain of a DNS-SD answer set into one entry per instance. */
export function assembleServices(records, name, senders = new Map()) {
    const addresses = new Map();
    const srv = new Map();
    const txt = new Map();
    const instances = new Set();
    for (const record of records) {
        if (record.type === DNS_TYPE.A && record.data) {
            addresses.set(record.name, record.data);
        } else if (record.type === DNS_TYPE.SRV && record.data) {
            srv.set(record.name, record.data);
        } else if (record.type === DNS_TYPE.TXT && record.data) {
            txt.set(record.name, record.data);
        } else if (record.type === DNS_TYPE.PTR && record.data && (!name || record.name === name)) {
            instances.add(record.data);
        }
    }
    // a device that answers with SRV but without the PTR we asked for still counts
    for (const key of srv.keys()) {
        if (!name || key.endsWith(name)) {
            instances.add(key);
        }
    }
    const found = [];
    for (const instance of instances) {
        const service = srv.get(instance);
        const host = service ? service.target : undefined;
        const address = (host && addresses.get(host)) || senders.get(instance) || (host && senders.get(host));
        if (!address) {
            continue;
        }
        found.push({
            address,
            instance: instance.replace(/\.$/, ''),
            name: instance.split('.')[0],
            host,
            port: service ? service.port : undefined,
            txt: txt.get(instance) || {},
        });
    }
    return found;
}

/*
 * UDP broadcast probe (the hm-discover pattern: send a magic datagram, parse what answers)
 */

/**
 * @param {object} options
 * @param {number} options.port remote port the probe is sent to
 * @param {Buffer|string} options.payload the datagram devices answer to
 * @param {(message: Buffer, rinfo: object) => (object|null)} [options.parse] null drops the answer
 * @returns {Promise<Array<object>>} the parsed answers, each with `address`
 */
export async function udpProbe({
    port,
    payload,
    parse,
    address = '255.255.255.255',
    broadcast = true,
    timeout = DEFAULT_TIMEOUT,
    tries = 2,
    createSocket = () => dgram.createSocket({type: 'udp4', reuseAddr: true}),
} = {}) {
    const message = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const targets = [].concat(address);
    const answers = [];
    const seen = new Set();
    const socket = createSocket();
    socket.on('message', (data, rinfo) => {
        if (seen.has(rinfo.address)) {
            return;
        }
        let parsed = {};
        if (parse) {
            try {
                parsed = parse(data, rinfo);
            } catch {
                parsed = null;
            }
        }
        if (!parsed) {
            return;
        }
        seen.add(rinfo.address);
        answers.push({address: rinfo.address, ...parsed});
    });
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(() => {
            socket.removeListener('error', reject);
            resolve();
        });
    });
    socket.on('error', () => {});
    try {
        if (broadcast && typeof socket.setBroadcast === 'function') {
            socket.setBroadcast(true);
        }
        for (let i = 0; i < tries; i++) {
            for (const target of targets) {
                socket.send(message, 0, message.length, port, target);
            }
            if (i + 1 < tries) {
                await delay(Math.min(300, timeout / (tries + 1)));
            }
        }
        await delay(timeout);
    } finally {
        socket.close();
    }
    return answers;
}

/*
 * ARP / OUI
 */

const execFile = promisify(execFileCb);

/** The host's ARP cache as [{address, mac}]; empty when the platform has no usable arp command. */
export async function arpTable({exec = execFile} = {}) {
    for (const [command, args] of [
        ['arp', ['-an']],
        ['ip', ['neigh', 'show']],
    ]) {
        try {
            const {stdout} = await exec(command, args);
            const entries = [];
            const pattern = /(\d+\.\d+\.\d+\.\d+)[^\n]*?\b([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/gi;
            for (const match of String(stdout).matchAll(pattern)) {
                entries.push({address: match[1], mac: normalizeMac(match[2])});
            }
            if (entries.length > 0) {
                return entries;
            }
        } catch {
            // try the next command
        }
    }
    return [];
}

export function normalizeMac(mac) {
    return String(mac)
        .toLowerCase()
        .split(':')
        .map((part) => part.padStart(2, '0'))
        .join(':');
}

/** true when `mac` starts with one of the OUI prefixes (any separator, any case). */
export function ouiMatch(mac, prefixes = []) {
    const flat = normalizeMac(mac).replace(/[^0-9a-f]/g, '');
    return prefixes.some((prefix) =>
        flat.startsWith(
            String(prefix)
                .toLowerCase()
                .replace(/[^0-9a-f]/g, ''),
        ),
    );
}

/*
 * the engine
 */

/** Merge a candidate into the result map, keyed by address; later fields never overwrite earlier. */
function addCandidate(found, address, fields, source) {
    if (!address) {
        return;
    }
    const entry = found.get(address) || {address, sources: []};
    for (const [key, value] of Object.entries(fields || {})) {
        if (value !== undefined && entry[key] === undefined) {
            entry[key] = value;
        }
    }
    if (source && !entry.sources.includes(source)) {
        entry.sources.push(source);
    }
    found.set(address, entry);
}

/** The declared ports, as {label: port}; an array or a single number is labelled by the port. */
function portMap(ports) {
    if (!ports) {
        return {};
    }
    if (typeof ports === 'number') {
        return {[ports]: ports};
    }
    if (Array.isArray(ports)) {
        return Object.fromEntries(ports.map((port) => [String(port), port]));
    }
    return ports;
}

/**
 * Run every method the hint declares and return what is on the network.
 *
 * @param {object} hint
 * @param {object|object[]} [hint.ssdp] `{st, match(headers)}` — M-SEARCH
 * @param {object|object[]} [hint.mdns] `{service, match(entry)}` — DNS-SD browse
 * @param {object|object[]} [hint.udp] `{port, payload, parse, address}` — broadcast probe
 * @param {object|number[]} [hint.ports] `{label: port}` probed on every candidate; a candidate
 *        with none of them open is dropped when `hint.requirePort` is not false
 * @param {string[]} [hint.oui] MAC prefixes — the ARP cache contributes candidates
 * @param {(address: string, entry: object) => (object|null|boolean)} [hint.probe] the last word
 * @param {object} [options]
 * @param {number} [options.timeout] ms per listener (default 5000)
 * @param {'auto'|boolean} [options.sweep] TCP sweep of the local subnets; 'auto' only when no
 *        other method found anything (default 'auto', and only with `hint.ports`)
 * @param {number} [options.concurrency] parallel TCP connects (default 32)
 * @param {object} [options.log]
 * @param {object} [options.deps] socket/exec/interface overrides for tests
 * @returns {Promise<Array<object>>} candidates sorted by address
 */
export async function discover(hint = {}, options = {}) {
    const {timeout = DEFAULT_TIMEOUT, sweep = 'auto', concurrency = 32, log = NO_LOG, deps = {}} = options;
    const found = new Map();
    const ports = portMap(hint.ports);
    const tasks = [];
    /**
     * Extra targets every method sends to, on top of its own group/broadcast address: the
     * broadcast address of each local subnet (255.255.255.255 is dropped by some stacks and never
     * leaves the wire on others) and whatever `--discover-address` named — the way to reach a
     * device one hop away, where no broadcast and no multicast arrives.
     */
    const extra = [...(options.addresses || []).filter(Boolean), ...localBroadcasts({interfaces: deps.interfaces})];
    const targets = (own) => [...new Set([own, ...extra])];

    for (const spec of [].concat(hint.ssdp || [])) {
        tasks.push(
            ssdpSearch({
                ...spec,
                address: targets(spec.address || SSDP_ADDRESS),
                timeout,
                createSocket: deps.createSocket,
            })
                .then((answers) => {
                    for (const {address, headers} of answers) {
                        if (spec.match && !spec.match(headers, address)) {
                            continue;
                        }
                        addCandidate(
                            found,
                            address,
                            {
                                name: headers.server,
                                usn: headers.usn,
                                location: headers.location,
                                st: headers.st || headers.nt,
                            },
                            'ssdp',
                        );
                    }
                })
                .catch((error) => log.debug('discovery: ssdp failed —', error.message)),
        );
    }

    for (const spec of [].concat(hint.mdns || [])) {
        tasks.push(
            mdnsQuery({
                ...spec,
                address: targets(spec.address || MDNS_ADDRESS),
                timeout,
                createSocket: deps.createSocket,
            })
                .then((entries) => {
                    for (const entry of entries) {
                        if (spec.match && !spec.match(entry)) {
                            continue;
                        }
                        addCandidate(found, entry.address, entry, 'mdns');
                    }
                })
                .catch((error) => log.debug('discovery: mdns failed —', error.message)),
        );
    }

    for (const spec of [].concat(hint.udp || [])) {
        tasks.push(
            udpProbe({
                ...spec,
                address: targets(spec.address || '255.255.255.255'),
                timeout,
                createSocket: deps.createSocket,
            })
                .then((answers) => {
                    for (const answer of answers) {
                        addCandidate(found, answer.address, answer, 'udp');
                    }
                })
                .catch((error) => log.debug('discovery: udp probe failed —', error.message)),
        );
    }

    if (hint.oui && hint.oui.length > 0) {
        tasks.push(
            arpTable({exec: deps.exec})
                .then((entries) => {
                    for (const entry of entries) {
                        if (ouiMatch(entry.mac, hint.oui)) {
                            addCandidate(found, entry.address, {mac: entry.mac}, 'oui');
                        }
                    }
                })
                .catch((error) => log.debug('discovery: arp lookup failed —', error.message)),
        );
    }

    await Promise.all(tasks);

    const portList = Object.entries(ports);
    const doSweep = portList.length > 0 && (sweep === true || (sweep === 'auto' && found.size === 0));
    if (doSweep) {
        const subnets = localSubnets({interfaces: deps.interfaces});
        for (const subnet of subnets) {
            const hosts = subnetHosts(subnet, {maxHosts: options.maxHosts});
            if (hosts.length === 0) {
                log.warn(`discovery: ${subnet.interface} ${subnet.network}/${subnet.netmask} is too big to sweep`);
                continue;
            }
            log.debug(`discovery: sweeping ${hosts.length} addresses on ${subnet.interface}`);
            await pool(
                hosts,
                async (address) => {
                    for (const [, port] of portList) {
                        if (await tcpProbe(address, port, {timeout: 1000, connect: deps.connect})) {
                            addCandidate(found, address, {}, 'sweep');
                            return;
                        }
                    }
                },
                concurrency,
            );
        }
    }

    let candidates = [...found.values()];

    if (portList.length > 0) {
        await pool(
            candidates,
            async (entry) => {
                const services = {};
                for (const [label, port] of portList) {
                    services[label] = await tcpProbe(entry.address, port, {timeout: 1000, connect: deps.connect});
                }
                entry.services = services;
            },
            concurrency,
        );
        if (hint.requirePort !== false) {
            candidates = candidates.filter((entry) => Object.values(entry.services).some(Boolean));
        }
    }

    if (typeof hint.probe === 'function') {
        const kept = [];
        await pool(
            candidates,
            async (entry) => {
                let result;
                try {
                    result = await hint.probe(entry.address, entry);
                } catch (error) {
                    log.debug(`discovery: probe ${entry.address} failed —`, error.message);
                    return;
                }
                if (!result) {
                    return;
                }
                kept.push(typeof result === 'object' ? Object.assign(entry, result) : entry);
            },
            concurrency,
        );
        candidates = kept;
    }

    candidates.sort((a, b) => ipToInt(a.address) - ipToInt(b.address));
    return candidates;
}

/**
 * Exactly one device, for `--address auto`: refuses to guess when the network answers with none
 * or with several (D: an adapter that picks one of two CCUs at random is worse than one that stops).
 */
export async function discoverOne(hint, options = {}) {
    const found = await discover(hint, options);
    if (found.length === 0) {
        throw new DiscoveryError('no device found on the network', {found});
    }
    if (found.length > 1) {
        throw new DiscoveryError(
            `${found.length} devices found (${found.map((entry) => entry.address).join(', ')}) — ` +
                'give the address explicitly',
            {found},
        );
    }
    return found[0];
}

/**
 * The address of the single device on the network, for `--address auto`. Pass the parsed config
 * and the scan honours `--discover-timeout` and `--discover-address` like `--discover` does.
 */
export async function autoAddress(hint, options = {}) {
    const {log = NO_LOG, config = {}} = options;
    const timeout =
        options.timeout ??
        (Number(config.discoverTimeout) > 0 ? Number(config.discoverTimeout) * 1000 : DEFAULT_TIMEOUT);
    const addresses = options.addresses ?? config.discoverAddress;
    log.info('discovering the device on the network …');
    const device = await discoverOne(hint, {...options, timeout, addresses});
    log.info(`discovered ${describe(device)}`);
    return device.address;
}

/*
 * CLI
 */

/** `--discover`, added to an adapter's options when it declares a discovery hint. */
export const DISCOVERY_OPTIONS = {
    discover: {
        type: 'boolean',
        describe: 'scan the network for devices, print what answers and exit',
    },
    'discover-json': {
        type: 'boolean',
        describe: 'print the result of --discover as JSON',
    },
    'discover-timeout': {
        type: 'number',
        describe: 'seconds --discover listens per method',
        default: DEFAULT_TIMEOUT / 1000,
    },
    'discover-address': {
        type: 'array',
        describe:
            "additional address --discover probes: a device (10.0.1.5) or another subnet's " +
            'broadcast (10.0.1.255), for devices a router away that no broadcast or multicast reaches',
    },
};

/** One line per device: address, what it calls itself, and the open ports of the hint. */
export function describe(entry) {
    const parts = [entry.address];
    const label = entry.name || entry.instance || entry.model || entry.type;
    if (label) {
        parts.push(String(label));
    }
    if (entry.serial) {
        parts.push(`serial ${entry.serial}`);
    }
    const open = Object.entries(entry.services || {})
        .filter(([, isOpen]) => isOpen)
        .map(([label_]) => label_);
    if (open.length > 0) {
        parts.push(`[${open.join(' ')}]`);
    }
    if (entry.sources && entry.sources.length > 0) {
        parts.push(`(${entry.sources.join('+')})`);
    }
    return parts.join('  ');
}

/**
 * The `--discover` handler: an adapter calls it right after parsing its config, before it touches
 * the device or the broker.
 *
 *   if (config.discover) {
 *       await runDiscovery({hint: DISCOVERY, config, log});
 *   }
 *
 * @returns {Promise<Array<object>>} what was found (the process exits before this resolves when
 *          `exit` is the real process.exit)
 */
export async function runDiscovery({
    hint,
    config = {},
    log = NO_LOG,
    print = console.log,
    exit = process.exit,
    deps,
} = {}) {
    const timeout = Number(config.discoverTimeout) > 0 ? Number(config.discoverTimeout) * 1000 : DEFAULT_TIMEOUT;
    const found = await discover(hint, {
        timeout,
        log,
        deps,
        addresses: config.discoverAddress,
        sweep: config.sweep === undefined ? 'auto' : config.sweep,
    });
    if (config.discoverJson) {
        print(JSON.stringify(found, null, 2));
    } else if (found.length === 0) {
        print('nothing found');
    } else {
        for (const entry of found) {
            print(describe(entry));
        }
    }
    exit(0);
    return found;
}
