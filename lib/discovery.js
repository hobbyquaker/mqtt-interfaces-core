/**
 * Device discovery (B-2): the scanning mechanics every adapter would otherwise repeat, written
 * exactly once — SSDP M-SEARCH, mDNS/DNS-SD browse, UDP broadcast probes, subnet TCP sweeps, an
 * ARP/OUI lookup and, for hardware that is not on the LAN at all, the vendor's device list —
 * driven by a declarative hint plus an optional `probe(address)`.
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
 *   export const DISCOVERY = {                                       // ecoflow2mqtt
 *       cloud: {list: () => listAccountDevices(config)},             // nothing to find on the LAN
 *       needs: ['email', 'password'],                                // --discover keeps demanding these
 *   };
 *
 * Every method contributes candidates; they are merged per address, the declared `ports` are
 * probed on each of them and `probe()` has the last word (returning null drops a candidate).
 *
 * The listeners are deliberately dependency-free: mDNS and SSDP are small enough to speak
 * directly, and an adapter on a Raspberry Pi should not pull a discovery stack per protocol.
 */

import dgram from 'node:dgram';
import {printSync} from './print.js';
import dnsPromises from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

/**
 * Let a socket send to broadcast addresses. Without SO_BROADCAST a send to one fails with
 * EACCES, and that error does not stay local: it surfaces on the socket and takes the queued
 * datagrams with it, so a single broadcast target silently kills the whole scan.
 */
function allowBroadcast(socket) {
    try {
        if (typeof socket.setBroadcast === 'function') {
            socket.setBroadcast(true);
        }
    } catch {
        // a socket that refuses (no permission, not bound): only unicast targets will work
    }
}

/**
 * Send one datagram, swallowing a per-target failure. The callback is what keeps an unreachable
 * or forbidden target from becoming a socket-level error that ends the scan.
 */
function send(socket, message, port, target) {
    try {
        socket.send(message, 0, message.length, port, target, () => {});
    } catch {
        // an address the stack rejects outright
    }
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

/**
 * Parse `172.16.20.0/24` into the same shape as `localSubnets()`; null when it is not a CIDR.
 * A bare address is not one — that is a single host, not a range.
 */
export function parseCidr(text) {
    const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(text).trim());
    if (!match) {
        return null;
    }
    const prefix = Number(match[2]);
    if (prefix < 0 || prefix > 32) {
        return null;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ipToInt(match[1]) & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    return {
        interface: text,
        address: match[1],
        netmask: intToIp(mask),
        network: intToIp(network),
        broadcast: intToIp(broadcast),
        hosts: Math.max(0, broadcast - network - 1),
    };
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
 * M-SEARCH for `st` and collect the unicast answers. The query is repeated `tries` times, spread
 * evenly over `timeout` — one lost datagram must not cost the whole scan, and a device that was
 * busy the first time gets another chance.
 * @returns {Promise<Array<{address: string, headers: object}>>}
 */
export async function ssdpSearch({
    st = 'ssdp:all',
    mx = 2,
    timeout = DEFAULT_TIMEOUT,
    address = SSDP_ADDRESS,
    port = SSDP_PORT,
    tries = 3,
    createSocket = () => dgram.createSocket({type: 'udp4', reuseAddr: true}),
} = {}) {
    const targets = [].concat(address);
    /**
     * One message per target: HOST names where this datagram is going. A device drops an
     * M-SEARCH whose HOST is not its own address or the SSDP group — including, memorably, one
     * built by interpolating the whole target list into the header.
     */
    const searchFor = (target) =>
        Buffer.from(
            `M-SEARCH * HTTP/1.1\r\nHOST: ${target}:${port}\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${st}\r\n\r\n`,
        );
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
    allowBroadcast(socket);
    try {
        for (let i = 0; i < tries; i++) {
            for (const target of targets) {
                send(socket, searchFor(target), port, target);
            }
            await delay(timeout / tries);
        }
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
 * Browse one DNS-SD service type, on two sockets:
 *
 *  - the query goes out from an ephemeral port with the unicast-response bit set, which is what
 *    devices on the link answer to directly;
 *  - a second socket joins the mDNS group on port 5353, because an answer that came through an
 *    mDNS reflector (avahi with `enable-reflector`, bridging two VLANs) arrives as multicast to
 *    the group, never as unicast to the ephemeral port. Without it, reflected devices are
 *    invisible. `reuseAddr` shares 5353 with a resolver already running on the host; when the
 *    bind fails anyway, the browse falls back to the ephemeral socket alone.
 *
 * @returns {Promise<Array<{address: string, instance: string, host: string, port: number, txt: object}>>}
 */
export async function mdnsQuery({
    service,
    timeout = DEFAULT_TIMEOUT,
    address = MDNS_ADDRESS,
    port = MDNS_PORT,
    tries = 3,
    listen = true,
    createSocket = () => dgram.createSocket({type: 'udp4', reuseAddr: true}),
} = {}) {
    const name = /\.local$/.test(service) ? service : `${service}.local`;
    const targets = [].concat(address);
    const query = encodeQuery(name);
    const records = [];
    const senders = new Map();
    const collect = (message, rinfo) => {
        for (const record of parseDnsMessage(message)) {
            records.push(record);
            senders.set(record.name, rinfo.address);
        }
    };
    const socket = createSocket({listen: false});
    socket.on('message', collect);
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(() => {
            socket.removeListener('error', reject);
            resolve();
        });
    });
    socket.on('error', () => {});

    let listener = null;
    if (listen) {
        try {
            listener = createSocket({listen: true});
            listener.on('message', collect);
            await new Promise((resolve, reject) => {
                listener.once('error', reject);
                listener.bind(port, () => {
                    listener.removeListener('error', reject);
                    resolve();
                });
            });
            listener.on('error', () => {});
            allowBroadcast(listener);
            for (const group of targets.filter((target) => target === MDNS_ADDRESS)) {
                if (typeof listener.addMembership === 'function') {
                    listener.addMembership(group);
                }
            }
        } catch {
            // 5353 taken without a shareable bind: the ephemeral socket still hears direct answers
            try {
                listener.close();
            } catch {
                // already gone
            }
            listener = null;
        }
    }

    allowBroadcast(socket);
    try {
        for (let i = 0; i < tries; i++) {
            for (const target of targets) {
                send(socket, query, port, target);
            }
            await delay(timeout / tries);
        }
    } finally {
        socket.close();
        if (listener) {
            try {
                listener.close();
            } catch {
                // already closed
            }
        }
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
 * Most devices answer to the port the probe came from, so the socket may take an ephemeral one.
 * Some answer to a fixed port instead and ignore the source port entirely — Govee's LAN API is
 * the case that forced this: the `scan` goes to 4001 and every device replies to 4002, so a
 * probe on an ephemeral port hears nothing at all. `bindPort` binds the sending socket there.
 *
 * The port may be taken — by a running adapter that holds it for exactly the same reason. The
 * socket is created with `reuseAddr`, which is enough to share it on most stacks; where it is
 * not, the bind rejects and `discover()` logs the probe as failed and carries on with whatever
 * its other methods found.
 *
 * @param {object} options
 * @param {number} options.port remote port the probe is sent to
 * @param {Buffer|string} options.payload the datagram devices answer to
 * @param {(message: Buffer, rinfo: object) => (object|null)} [options.parse] null drops the answer
 * @param {number} [options.bindPort] local port to bind (default 0: an ephemeral one)
 * @returns {Promise<Array<object>>} the parsed answers, each with `address`
 */
export async function udpProbe({
    port,
    payload,
    parse,
    address = '255.255.255.255',
    broadcast = true,
    bindPort = 0,
    timeout = DEFAULT_TIMEOUT,
    tries = 3,
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
        socket.bind(bindPort, () => {
            socket.removeListener('error', reject);
            resolve();
        });
    });
    socket.on('error', () => {});
    try {
        if (broadcast) {
            allowBroadcast(socket);
        }
        for (let i = 0; i < tries; i++) {
            for (const target of targets) {
                send(socket, message, port, target);
            }
            await delay(timeout / tries);
        }
    } finally {
        socket.close();
    }
    return answers;
}

/*
 * names
 */

/** A hostname worth putting in a config: letters, digits, dashes and dots, nothing exotic. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * The names an address answers to, verified by a round trip: reverse the address, then resolve
 * each name back and keep it only when the address is among the answers. That single check
 * subsumes every "is DNS working here" question — a resolver can serve public names perfectly
 * and have no PTR zone for RFC1918, or a PTR that points at a name nothing resolves.
 *
 * Both fields are verified separately and both are optional:
 *
 *   fqdn      qualified and round-trips — safe to put in a config
 *   hostname  the short label, and only when *it* round-trips here. That depends on the
 *             resolver's search list (`audiocast` resolves on a host with `search example.lan`
 *             and nowhere else), so it is offered, never preferred.
 *
 * The forward half uses `dns.lookup`, the same resolution path an adapter uses at runtime,
 * rather than `dns.resolve4`, which bypasses the system resolver.
 *
 * @returns {Promise<{fqdn?: string, hostname?: string}>}
 */
export async function resolveNames(address, {timeout = 2000, deps = {}} = {}) {
    const resolver = deps.dns || dnsPromises;
    if (!isIpv4(address)) {
        return {};
    }
    const withTimeout = (promise) =>
        Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))]);
    let names;
    try {
        names = await withTimeout(resolver.reverse(address));
    } catch {
        return {}; // no PTR zone, no resolver, or too slow to be worth waiting for
    }
    /** Does `name` resolve back to this address? */
    const roundTrips = async (name) => {
        try {
            const answers = await withTimeout(resolver.lookup(name, {all: true, family: 4}));
            return answers.some((answer) => answer.address === address);
        } catch {
            return false;
        }
    };
    const found = {};
    for (const raw of names || []) {
        const name = String(raw).replace(/\.$/, '').toLowerCase();
        if (!HOSTNAME.test(name)) {
            continue;
        }
        // .local resolves only where mDNS resolution exists (Bonjour, nss-mdns) — it would verify
        // here and then fail inside a container on the very same host
        if (/\.local$/.test(name)) {
            continue;
        }
        if (!found.fqdn && name.includes('.') && (await roundTrips(name))) {
            found.fqdn = name;
        }
        const short = name.split('.')[0];
        if (!found.hostname && (await roundTrips(short))) {
            found.hostname = short;
        }
        if (found.fqdn && found.hostname) {
            break;
        }
    }
    return found;
}

/*
 * serial devices
 */

/** Where Linux keeps the stable names of USB serial adapters. */
export const SERIAL_BY_ID = '/dev/serial/by-id';

/**
 * The USB serial adapters attached to this host, by their stable name.
 *
 * `/dev/serial/by-id/usb-busware.de_CUL868-if00` is a symlink udev maintains: it survives a
 * replug and a reboot, while the `/dev/ttyACM0` it points at does not — with two sticks attached
 * the numbers can swap. That name is what an adapter should be configured with, so it is the
 * identity here, and the device node comes along as `device`.
 *
 * macOS has no by-id directory; `/dev/cu.usb*` is listed instead, where the name is all there is.
 * Other platforms return nothing rather than guessing.
 *
 * @returns {Array<{id: string, path: string, device: string}>}
 */
export function listSerialPorts({dir = SERIAL_BY_ID, deps = {}} = {}) {
    const io = deps.fs || fs;
    const ports = [];
    try {
        for (const id of io.readdirSync(dir).sort()) {
            const link = path.join(dir, id);
            let device = link;
            try {
                device = io.realpathSync(link);
            } catch {
                // a dangling symlink: keep the name, the device node is gone
            }
            ports.push({id, path: link, device});
        }
        return ports;
    } catch {
        // no by-id directory (macOS, or no udev): fall back to the raw device nodes
    }
    try {
        for (const name of io.readdirSync('/dev').sort()) {
            if (/^cu\.(usb|SLAB|wch)/i.test(name)) {
                const device = path.join('/dev', name);
                ports.push({id: name, path: device, device});
            }
        }
    } catch {
        // no /dev to speak of
    }
    return ports;
}

/**
 * Does a serial port match what the adapter is looking for?
 * @param {{id: string}} port
 * @param {{contains?: string[], match?: RegExp | ((port: object) => boolean)}} spec
 */
export function serialMatches(port, spec = {}) {
    const id = String(port.id || '');
    if (typeof spec.match === 'function' && !spec.match(port)) {
        return false;
    }
    if (spec.match instanceof RegExp && !spec.match.test(id)) {
        return false;
    }
    if (Array.isArray(spec.contains)) {
        const lower = id.toLowerCase();
        if (!spec.contains.every((word) => lower.includes(String(word).toLowerCase()))) {
            return false;
        }
    }
    return true;
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

/** Candidates are keyed by address; a serial port's key is its by-id path, not an ipv4 address. */
function isIpv4(address) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(String(address));
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
 * @param {object|object[]} [hint.udp] `{port, payload, parse, address, bindPort}` — broadcast probe
 * @param {object|object[]|true} [hint.cloud] `{list({timeout})}` — the account's devices, for
 *        hardware that is not on the LAN at all; `list` returns `[{id, name, model, …}]` and its
 *        failures propagate rather than being swallowed (a wrong password is not an empty
 *        network). A cloud hint usually needs credentials and so cannot be built before the
 *        config is parsed: `cloud: true` declares the kind for `parseConfig`/`--config-schema`
 *        without a callable, and a spec without a `list` is skipped here rather than crashing
 * @param {object|number[]} [hint.ports] `{label: port}` probed on every candidate; a candidate
 *        with none of them open is dropped when `hint.requirePort` is not false
 * @param {string[]} [hint.oui] MAC prefixes — the ARP cache contributes candidates
 * @param {(address: string, entry: object) => (object|null|boolean)} [hint.probe] the last word
 * @param {object} [options]
 * @param {number} [options.timeout] ms per listener (default 5000)
 * @param {'auto'|boolean} [options.sweep] TCP sweep of the local subnets; 'auto' only when no
 *        other method found anything (default 'auto', and only with `hint.ports`)
 * @param {number} [options.concurrency] parallel TCP connects (default 32)
 * @param {boolean} [options.names] false skips the reverse lookup (default: resolve)
 * @param {object} [options.log]
 * @param {object} [options.deps] socket/exec/interface/dns overrides for tests
 * @returns {Promise<Array<object>>} candidates sorted by address, each with the verified `fqdn`
 *          and `hostname` when DNS knows the device
 */
export async function discover(hint = {}, options = {}) {
    const {timeout = DEFAULT_TIMEOUT, sweep = 'auto', concurrency = 32, names, log = NO_LOG, deps = {}} = options;
    const found = new Map();
    const ports = portMap(hint.ports);
    const tasks = [];
    /**
     * Extra targets every method sends to, on top of its own group/broadcast address: the
     * broadcast address of each local subnet (255.255.255.255 is dropped by some stacks and never
     * leaves the wire on others) and whatever `--discover-address` named — the way to reach a
     * device one hop away, where no broadcast and no multicast arrives.
     */
    const named = [];
    /** `--discover-address 172.16.20.0/24`: a whole range to sweep, not a single host. */
    const ranges = [];
    for (const item of (options.addresses || []).filter(Boolean)) {
        const subnet = parseCidr(item);
        if (subnet) {
            ranges.push(subnet);
        } else {
            named.push(item);
        }
    }
    const extra = [
        ...named,
        ...ranges.map((subnet) => subnet.broadcast),
        ...localBroadcasts({interfaces: deps.interfaces}),
    ];
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

    if (hint.serial) {
        for (const spec of [].concat(hint.serial)) {
            try {
                for (const port of listSerialPorts({dir: spec.dir, deps})) {
                    if (serialMatches(port, spec)) {
                        addCandidate(found, port.path, {id: port.id, device: port.device}, 'serial');
                    }
                }
            } catch (error) {
                log.debug('discovery: serial scan failed —', error.message);
            }
        }
    }

    /*
     * The account's devices, for an adapter whose hardware is not on the LAN at all: an EcoFlow
     * inverter only ever talks to EcoFlow's cloud, so the thing to configure is a serial number
     * read out of the vendor's app, and the only way to "find" it is to ask the vendor.
     *
     * Two things make this unlike the network methods. It is the *only* method such a hint
     * declares, and it needs credentials to run, so a failure is not "this probe found nothing"
     * but "your password is wrong" — swallowing it the way a failed ssdp search is swallowed
     * would report an empty network for a wrong password. It therefore propagates.
     */
    for (const spec of [].concat(hint.cloud || []).filter((spec) => typeof spec?.list === 'function')) {
        tasks.push(
            Promise.resolve()
                .then(() => spec.list({timeout}))
                .then((entries) => {
                    for (const {id, ...fields} of entries || []) {
                        addCandidate(found, id, fields, 'cloud');
                    }
                })
                .catch((error) => {
                    throw error instanceof DiscoveryError
                        ? error
                        : new DiscoveryError(`the account could not be listed — ${error.message}`, {cause: error});
                }),
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
    if (portList.length > 0 && (doSweep || ranges.length > 0)) {
        // a range was named explicitly, so it is swept whatever the `sweep` rule says
        const subnets = [...ranges, ...(doSweep ? localSubnets({interfaces: deps.interfaces}) : [])];
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

    /*
     * An address named with --discover-address is a candidate in its own right, not just a probe
     * target: mDNS and broadcasts are link-local, so a device one subnet away answers none of the
     * methods above — knocking on its declared ports is the only proof available. Without ports
     * there is nothing to confirm it with, so it stays a target only.
     */
    if (portList.length > 0) {
        for (const address of named) {
            if (!found.has(address)) {
                addCandidate(found, address, {}, 'address');
            }
        }
    }

    let candidates = [...found.values()];

    if (portList.length > 0) {
        await pool(
            // a serial stick has no tcp ports to knock on; it was found by being plugged in
            candidates.filter((entry) => isIpv4(entry.address)),
            async (entry) => {
                const services = {};
                for (const [label, port] of portList) {
                    services[label] = await tcpProbe(entry.address, port, {timeout: 1000, connect: deps.connect});
                }
                entry.services = services;
            },
            concurrency,
        );
        const anyPortOpen = (entry) => Object.values(entry.services || {}).some(Boolean);
        candidates = candidates.filter((entry) => {
            if (!entry.services) {
                return true; // nothing was probed here (a serial port): the ports say nothing about it
            }
            // a named address is nothing but an address until one of its ports answers, however
            // forgiving `requirePort` is about devices that announced themselves
            return hint.requirePort === false
                ? !entry.sources.includes('address') || anyPortOpen(entry)
                : anyPortOpen(entry);
        });
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

    if (names !== false) {
        await pool(
            candidates.filter((entry) => isIpv4(entry.address)),
            async (entry) => Object.assign(entry, await resolveNames(entry.address, {deps})),
            concurrency,
        );
    }

    candidates.sort((a, b) => {
        const [ipA, ipB] = [isIpv4(a.address), isIpv4(b.address)];
        if (ipA && ipB) {
            return ipToInt(a.address) - ipToInt(b.address);
        }
        return ipA === ipB ? String(a.address).localeCompare(String(b.address)) : ipA ? -1 : 1;
    });
    return candidates;
}

/**
 * Where `auto` is about to go looking, for the log line that says so. A cloud hint scans no
 * network — it logs into an account — and saying otherwise is the same wrong sentence the
 * `--discover` help used to carry.
 */
function where(hint) {
    const kinds = discoveryKinds(hint);
    if (kinds.length === 1 && kinds[0] === 'cloud') {
        return 'in the account';
    }
    if (kinds.length === 1 && kinds[0] === 'serial') {
        return 'on this host';
    }
    return 'on the network';
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
    log.info(`discovering the device ${where(hint)} …`);
    const device = await discoverOne(hint, {...options, timeout, addresses});
    log.info(`discovered ${describe(device)}`);
    /*
     * The qualified name outlives a dhcp lease, so it is the better thing to put in a config —
     * but only the qualified one: the short form resolves through the search list of whoever
     * asks, which is not necessarily this host. --discover-ip pins the address instead.
     */
    if (config.discoverIp || options.ip) {
        return device.address;
    }
    return device.fqdn || device.address;
}

/**
 * Every address on the network, for a bridge whose address option is a list (`--address auto` on
 * govee2mqtt, cul2mqtt's sticks): one instance talks to all of them, so unlike `autoAddress`
 * finding several is the normal outcome and not an error. Finding none still is — an empty list
 * would silently start a bridge with nothing to bridge.
 *
 * Name preference is the same as `autoAddress`: the verified qualified name outlives a dhcp
 * lease, `--discover-ip` pins the address instead.
 *
 * @returns {Promise<string[]>} in the order `discover()` sorted them (by address)
 */
export async function autoAddresses(hint, options = {}) {
    const {log = NO_LOG, config = {}} = options;
    const timeout =
        options.timeout ??
        (Number(config.discoverTimeout) > 0 ? Number(config.discoverTimeout) * 1000 : DEFAULT_TIMEOUT);
    const addresses = options.addresses ?? config.discoverAddress;
    log.info(`discovering devices ${where(hint)} …`);
    const found = await discover(hint, {...options, timeout, addresses});
    if (found.length === 0) {
        throw new DiscoveryError('no device found on the network', {found});
    }
    log.info(`discovered ${found.map((entry) => describe(entry)).join(', ')}`);
    const pin = config.discoverIp || options.ip;
    return found.map((entry) => (pin ? entry.address : entry.fqdn || entry.address));
}

/*
 * CLI
 */

/**
 * What kind of scanning a hint asks for, so a management UI knows which affordances to show: a
 * network scan has a timeout and can be pointed at another subnet, a serial scan is a directory
 * listing that is instantly done. An adapter that speaks both (a CUN is a CUL with ethernet)
 * yields both, in that order.
 * @returns {Array<'network' | 'serial'>}
 */
export function discoveryKinds(hint) {
    if (!hint || typeof hint !== 'object') {
        return [];
    }
    const kinds = [];
    if (hint.ssdp || hint.mdns || hint.udp || hint.ports || hint.oui) {
        kinds.push('network');
    }
    if (hint.serial) {
        kinds.push('serial');
    }
    if (hint.cloud) {
        kinds.push('cloud');
    }
    return kinds;
}

/**
 * Options an adapter's own scan consumes and that `--discover` must therefore keep demanding.
 *
 * `--discover` drops mandatory options, because the address it is about to go looking for must
 * not be required to look for it. A cloud hint inverts that for its credentials: without
 * `--email` and `--password` there is no account to list, and dropping them turns a missing
 * option into an api error much further down. `hint.needs` names them; the option the scan
 * *fills* is never among them.
 *
 * @returns {string[]} option names, kebab-case as declared
 */
export function discoveryNeeds(hint) {
    if (!hint || typeof hint !== 'object' || !Array.isArray(hint.needs)) {
        return [];
    }
    return hint.needs.filter((key) => typeof key === 'string' && key);
}

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
    'discover-ip': {
        type: 'boolean',
        describe: 'use the ip address for --address auto, even when the device has a dns name',
    },
    'discover-address': {
        type: 'array',
        describe:
            'additional target for --discover: a device (10.0.1.5) or a range to sweep ' +
            '(10.0.1.0/24), for devices a router away that no broadcast or multicast reaches',
    },
};

/**
 * The `--discover*` options an adapter actually gets, given its hint.
 *
 * A cloud-only hint scans no network, so `--discover-address` (a subnet to sweep) and
 * `--discover-ip` (prefer the address over the dns name) are not merely unused there but
 * misleading, and "scan the network for devices" is the wrong sentence for logging into an
 * account. Anything else — including `discovery: true`, which declares no kind — keeps the full
 * network set, so nothing changes for the adapters that had it before.
 */
export function discoveryOptions(hint) {
    const kinds = discoveryKinds(hint);
    const cloudOnly = kinds.length === 1 && kinds[0] === 'cloud';
    const {'discover-ip': ip, 'discover-address': address, ...common} = DISCOVERY_OPTIONS;
    if (!cloudOnly) {
        return {...common, 'discover-ip': ip, 'discover-address': address};
    }
    return {
        ...common,
        discover: {...common.discover, describe: 'list the devices of the account and exit'},
        'discover-timeout': {...common['discover-timeout'], describe: 'seconds the account listing may take'},
    };
}

/** One line per device: address, what it calls itself, and the open ports of the hint. */
export function describe(entry) {
    const parts = [entry.address];
    if (entry.fqdn) {
        parts.push(entry.fqdn);
    }
    if (entry.device && entry.device !== entry.address) {
        parts.push(`→ ${entry.device}`);
    }
    const label = entry.name || entry.instance || entry.model || entry.type;
    if (label) {
        parts.push(String(label));
    }
    if (entry.serial) {
        parts.push(`serial ${entry.serial}`);
    }
    // only when the source actually reported it: a device nothing said this about is not offline
    if (entry.online === false) {
        parts.push('offline');
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
    // synchronous, because this prints and exits immediately after - see printSync
    print = printSync,
    exit = process.exit,
    deps,
} = {}) {
    const timeout = Number(config.discoverTimeout) > 0 ? Number(config.discoverTimeout) * 1000 : DEFAULT_TIMEOUT;
    let found;
    try {
        found = await discover(hint, {
            timeout,
            log,
            deps,
            addresses: config.discoverAddress,
            sweep: config.sweep === undefined ? 'auto' : config.sweep,
        });
    } catch (error) {
        /*
         * A network scan has nothing to fail at — a method that finds nothing is a result, not an
         * error. A cloud hint does: wrong credentials, an api that moved. Say so and exit non-zero
         * rather than letting an unhandled rejection print a stack trace at the user.
         */
        log.error(`--discover: ${error.message}`);
        exit(1);
        return [];
    }
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
