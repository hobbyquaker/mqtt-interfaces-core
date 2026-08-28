/**
 * Device discovery (B-2). The sockets are faked throughout: a `createSocket` that answers a send
 * with canned datagrams, and a `connect` that opens only for a known set of address:port pairs.
 * The wire formats (DNS-SD, SSDP, the eQ-3 broadcast of hm-discover) are tested against real
 * captures, not against what the encoder happens to produce.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {
    DNS_TYPE,
    arpTable,
    assembleServices,
    autoAddress,
    describe as describeEntry,
    discover,
    discoverOne,
    encodeName,
    encodeQuery,
    intToIp,
    listSerialPorts,
    ipToInt,
    localSubnets,
    mdnsQuery,
    normalizeMac,
    ouiMatch,
    parseCidr,
    parseDnsMessage,
    parseSsdp,
    pool,
    readName,
    serialMatches,
    runDiscovery,
    ssdpSearch,
    subnetHosts,
    tcpProbe,
    udpProbe,
} from '../lib/discovery.js';

/** A dgram socket that replies to every send with the datagrams of `answers`. */
function fakeSocket(answers = []) {
    const socket = new EventEmitter();
    socket.sent = [];
    socket.closed = false;
    socket.broadcast = false;
    socket.groups = [];
    socket.boundPort = null;
    // dgram accepts bind(cb) and bind(port, cb) — the mDNS listener uses the latter
    socket.bind = (portOrCallback, maybeCallback) => {
        const callback = typeof portOrCallback === 'function' ? portOrCallback : maybeCallback;
        socket.boundPort = typeof portOrCallback === 'number' ? portOrCallback : 0;
        setImmediate(() => callback && callback());
    };
    socket.addMembership = (group) => socket.groups.push(group);
    socket.setBroadcast = (value) => {
        socket.broadcast = value;
    };
    socket.close = () => {
        socket.closed = true;
    };
    socket.send = (message, offset, length, port, address) => {
        socket.sent.push({message, port, address});
        for (const answer of answers) {
            setImmediate(() =>
                socket.emit('message', answer.message, {address: answer.address, port: answer.port || port}),
            );
        }
    };
    return socket;
}

/** A net.connect that succeeds for the given `address:port` strings and errors for the rest. */
function fakeConnect(open = []) {
    const set = new Set(open);
    return ({host, port}) => {
        const socket = new EventEmitter();
        socket.setTimeout = () => {};
        socket.destroy = () => {};
        setImmediate(() => {
            if (set.has(`${host}:${port}`)) {
                socket.emit('connect');
            } else {
                socket.emit('error', new Error('ECONNREFUSED'));
            }
        });
        return socket;
    };
}

const FAST = {timeout: 5, tries: 1};

describe('pool', () => {
    test('runs everything and never exceeds the concurrency', async () => {
        let running = 0;
        let peak = 0;
        const results = await pool(
            [1, 2, 3, 4, 5, 6, 7],
            async (item) => {
                running++;
                peak = Math.max(peak, running);
                await new Promise((resolve) => setImmediate(resolve));
                running--;
                return item * 2;
            },
            3,
        );
        assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
        assert.ok(peak <= 3, `peak ${peak}`);
    });

    test('an empty list needs no runner', async () => {
        assert.deepEqual(await pool([], async () => 1, 4), []);
    });
});

describe('addresses', () => {
    test('ip <-> int round trip', () => {
        for (const ip of ['0.0.0.0', '192.168.1.20', '10.0.0.255', '255.255.255.255']) {
            assert.equal(intToIp(ipToInt(ip)), ip);
        }
    });

    test('localSubnets skips internal and ipv6 addresses', () => {
        const interfaces = () => ({
            lo0: [{family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true}],
            en0: [
                {family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false},
                {family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false},
            ],
        });
        const subnets = localSubnets({interfaces});
        assert.equal(subnets.length, 1);
        assert.deepEqual(
            {...subnets[0]},
            {
                interface: 'en0',
                address: '192.168.1.20',
                netmask: '255.255.255.0',
                network: '192.168.1.0',
                broadcast: '192.168.1.255',
                hosts: 254,
            },
        );
    });

    test('parseCidr turns a range into a subnet, and a bare address into nothing', () => {
        assert.deepEqual(parseCidr('172.16.20.0/24'), {
            interface: '172.16.20.0/24',
            address: '172.16.20.0',
            netmask: '255.255.255.0',
            network: '172.16.20.0',
            broadcast: '172.16.20.255',
            hosts: 254,
        });
        assert.equal(parseCidr('172.16.20.180'), null, 'a bare address is a host, not a range');
        assert.equal(parseCidr('nonsense'), null);
        assert.equal(parseCidr('172.16.20.0/33'), null);
        // a host address inside the range still yields the range it belongs to
        assert.equal(parseCidr('172.16.20.180/24').network, '172.16.20.0');
    });

    test('subnetHosts covers .1 … .254 and refuses a subnet that is too big', () => {
        const subnet = {network: '192.168.1.0', netmask: '255.255.255.0', hosts: 254};
        const hosts = subnetHosts(subnet);
        assert.equal(hosts.length, 254);
        assert.equal(hosts[0], '192.168.1.1');
        assert.equal(hosts.at(-1), '192.168.1.254');
        assert.deepEqual(subnetHosts({network: '10.0.0.0', hosts: 16777214}), []);
    });
});

describe('tcpProbe', () => {
    test('open port', async () => {
        assert.equal(await tcpProbe('192.168.1.5', 1999, {connect: fakeConnect(['192.168.1.5:1999'])}), true);
    });

    test('closed port', async () => {
        assert.equal(await tcpProbe('192.168.1.5', 2001, {connect: fakeConnect(['192.168.1.5:1999'])}), false);
    });

    test('a connect that throws synchronously is a closed port, not a crash', async () => {
        const connect = () => {
            throw new Error('EINVAL');
        };
        assert.equal(await tcpProbe('nonsense', 1, {connect}), false);
    });
});

describe('ssdp', () => {
    const response = [
        'HTTP/1.1 200 OK',
        'CACHE-CONTROL: max-age=1800',
        'LOCATION: http://192.168.1.20:3000/description.xml',
        'SERVER: WebOS/1.0 UPnP/1.0',
        'ST: urn:lge-com:service:webos-second-screen:1',
        'USN: uuid:aabbccdd::urn:lge-com:service:webos-second-screen:1',
        '',
        '',
    ].join('\r\n');

    test('parseSsdp lower-cases the header names', () => {
        const headers = parseSsdp(response);
        assert.equal(headers.server, 'WebOS/1.0 UPnP/1.0');
        assert.equal(headers.st, 'urn:lge-com:service:webos-second-screen:1');
        assert.equal(headers.location, 'http://192.168.1.20:3000/description.xml');
    });

    test('parseSsdp rejects anything that is not a response or a notify', () => {
        assert.equal(parseSsdp('GET / HTTP/1.1\r\nHost: x\r\n\r\n'), null);
        assert.equal(parseSsdp(''), null);
    });

    test('M-SEARCH goes to the group and the answers carry the sender address', async () => {
        const socket = fakeSocket([{message: Buffer.from(response), address: '192.168.1.20'}]);
        const answers = await ssdpSearch({st: 'ssdp:all', ...FAST, createSocket: () => socket});
        assert.equal(answers.length, 1);
        assert.equal(answers[0].address, '192.168.1.20');
        assert.equal(answers[0].headers.st, 'urn:lge-com:service:webos-second-screen:1');
        assert.match(String(socket.sent[0].message), /^M-SEARCH \* HTTP\/1\.1/);
        assert.match(String(socket.sent[0].message), /ST: ssdp:all/);
        assert.equal(socket.sent[0].address, '239.255.255.250');
        assert.equal(socket.sent[0].port, 1900);
        assert.ok(socket.closed, 'socket closed');
    });
});

describe('dns / mdns', () => {
    test('encodeName writes length-prefixed labels and a root byte', () => {
        assert.deepEqual([...encodeName('_googlecast._tcp.local')], [
            11, 0x5f, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x63, 0x61, 0x73, 0x74,
            4, 0x5f, 0x74, 0x63, 0x70,
            5, 0x6c, 0x6f, 0x63, 0x61, 0x6c,
            0,
        ]); // prettier-ignore
    });

    test('encodeQuery asks one PTR question with the unicast-response bit', () => {
        const query = encodeQuery('_googlecast._tcp.local');
        assert.equal(query.readUInt16BE(4), 1, 'one question');
        const tail = query.subarray(query.length - 4);
        assert.equal(tail.readUInt16BE(0), DNS_TYPE.PTR);
        assert.equal(tail.readUInt16BE(2), 0x8001, 'QU bit + IN');
    });

    test('readName follows a compression pointer', () => {
        // "local" at offset 12, then a name "x" pointing back to it
        const buffer = Buffer.concat([Buffer.alloc(12), encodeName('local'), Buffer.from([1, 0x78, 0xc0, 12])]);
        const [name, after] = readName(buffer, 12 + 7);
        assert.equal(name, 'x.local');
        assert.equal(after, buffer.length);
    });

    test('readName survives a pointer loop', () => {
        const buffer = Buffer.alloc(16);
        buffer[12] = 0xc0;
        buffer[13] = 12; // points at itself
        const [name] = readName(buffer, 12);
        assert.equal(typeof name, 'string');
    });

    test('parseDnsMessage reads PTR, SRV, TXT and A of a DNS-SD answer', () => {
        const message = buildResponse('_googlecast._tcp.local', {
            instance: 'Living Room._googlecast._tcp.local',
            host: 'living.local',
            port: 8009,
            address: '192.168.1.31',
            txt: {md: 'Chromecast', fn: 'Living Room'},
        });
        const records = parseDnsMessage(message);
        const ptr = records.find((r) => r.type === DNS_TYPE.PTR);
        const srv = records.find((r) => r.type === DNS_TYPE.SRV);
        const txt = records.find((r) => r.type === DNS_TYPE.TXT);
        const a = records.find((r) => r.type === DNS_TYPE.A);
        assert.equal(ptr.data, 'Living Room._googlecast._tcp.local');
        assert.equal(srv.data.port, 8009);
        assert.equal(srv.data.target, 'living.local');
        assert.deepEqual(txt.data, {md: 'Chromecast', fn: 'Living Room'});
        assert.equal(a.data, '192.168.1.31');
    });

    test('parseDnsMessage returns what it got when the message is truncated', () => {
        assert.deepEqual(parseDnsMessage(Buffer.from([0, 0, 0])), []);
    });

    test('assembleServices joins PTR → SRV → A into one entry per instance', () => {
        const records = parseDnsMessage(
            buildResponse('_googlecast._tcp.local', {
                instance: 'Living Room._googlecast._tcp.local',
                host: 'living.local',
                port: 8009,
                address: '192.168.1.31',
                txt: {md: 'Chromecast'},
            }),
        );
        const found = assembleServices(records, '_googlecast._tcp.local');
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '192.168.1.31');
        assert.equal(found[0].name, 'Living Room');
        assert.equal(found[0].port, 8009);
        assert.equal(found[0].txt.md, 'Chromecast');
    });

    test('an instance without an A record falls back to the sender address', () => {
        const records = [
            {name: '_x._tcp.local', type: DNS_TYPE.PTR, data: 'Box._x._tcp.local'},
            {name: 'Box._x._tcp.local', type: DNS_TYPE.SRV, data: {target: 'box.local', port: 80}},
        ];
        const found = assembleServices(records, '_x._tcp.local', new Map([['Box._x._tcp.local', '10.0.0.9']]));
        assert.equal(found[0].address, '10.0.0.9');
    });

    test('an answer reflected onto the group (avahi bridging two VLANs) is heard too', async () => {
        // the reflected answer is multicast to 5353, never unicast to the ephemeral sender port
        const sender = fakeSocket([]);
        const listener = fakeSocket([]);
        const message = buildResponse('_googlecast._tcp.local', {
            instance: 'Soundbar._googlecast._tcp.local',
            host: 'sb.local',
            port: 8009,
            address: '172.16.20.180',
            txt: {fn: 'Wohnzimmer', md: 'LG S95QR'},
        });
        const query = mdnsQuery({
            service: '_googlecast._tcp',
            ...FAST,
            timeout: 40,
            createSocket: ({listen}) => (listen ? listener : sender),
        });
        setImmediate(() => listener.emit('message', message, {address: '172.16.23.1'}));
        const found = await query;
        assert.equal(listener.boundPort, 5353, 'the listener binds the mDNS port');
        assert.deepEqual(listener.groups, ['224.0.0.251'], 'and joins the group');
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '172.16.20.180');
        assert.equal(found[0].txt.fn, 'Wohnzimmer');
        assert.ok(listener.closed && sender.closed, 'both sockets closed');
    });

    test('a listener that cannot bind 5353 leaves the browse working', async () => {
        const sender = fakeSocket([
            {
                message: buildResponse('_x._tcp.local', {
                    instance: 'Box._x._tcp.local',
                    host: 'box.local',
                    port: 1,
                    address: '10.0.0.9',
                    txt: {},
                }),
                address: '10.0.0.9',
            },
        ]);
        const found = await mdnsQuery({
            service: '_x._tcp',
            ...FAST,
            createSocket: ({listen}) => {
                if (listen) {
                    throw new Error('EADDRINUSE');
                }
                return sender;
            },
        });
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '10.0.0.9');
    });

    test('mdnsQuery sends to the group and returns the assembled services', async () => {
        const message = buildResponse('_googlecast._tcp.local', {
            instance: 'Soundbar._googlecast._tcp.local',
            host: 'sb.local',
            port: 8009,
            address: '192.168.1.44',
            txt: {},
        });
        const socket = fakeSocket([{message, address: '192.168.1.44'}]);
        const found = await mdnsQuery({service: '_googlecast._tcp', ...FAST, createSocket: () => socket});
        assert.equal(socket.sent[0].address, '224.0.0.251');
        assert.equal(socket.sent[0].port, 5353);
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '192.168.1.44');
        assert.equal(found[0].name, 'Soundbar');
    });
});

describe('udpProbe (the hm-discover pattern)', () => {
    // the eQ-3 broadcast probe and the reply layout hm-discover parses
    const PROBE = Buffer.from([0x02, 0x8f, 0x91, 0xc0, 0x01, 0x65, 0x51, 0x33, 0x2d, 0x2a, 0x00, 0x2a, 0x00, 0x49]);
    const reply = Buffer.concat([
        Buffer.from([0x02, 0x8f, 0x91, 0xc0, 0x01]),
        Buffer.from('eQ3-HM-CCU2-App\0KEQ0112345\0'),
        Buffer.from([0, 0, 0]),
        Buffer.from('3.75.6\0'),
    ]);

    function parseEq3(message) {
        if (message.subarray(0, 5).toString('hex') !== '028f91c001') {
            return null;
        }
        const parts = message.subarray(5).toString('binary').split('\0');
        return {type: parts[0], serial: parts[1]};
    }

    test('broadcasts the payload and parses the answers', async () => {
        const socket = fakeSocket([{message: reply, address: '192.168.1.130'}]);
        const found = await udpProbe({
            port: 43439,
            payload: PROBE,
            parse: parseEq3,
            ...FAST,
            createSocket: () => socket,
        });
        assert.equal(socket.broadcast, true, 'SO_BROADCAST set');
        assert.equal(socket.sent[0].address, '255.255.255.255');
        assert.equal(socket.sent[0].port, 43439);
        assert.deepEqual(found, [{address: '192.168.1.130', type: 'eQ3-HM-CCU2-App', serial: 'KEQ0112345'}]);
    });

    test('foreign datagrams are dropped and every address answers once', async () => {
        const socket = fakeSocket([
            {message: Buffer.from('something else'), address: '192.168.1.7'},
            {message: reply, address: '192.168.1.130'},
            {message: reply, address: '192.168.1.130'},
        ]);
        const found = await udpProbe({
            port: 43439,
            payload: PROBE,
            parse: parseEq3,
            ...FAST,
            createSocket: () => socket,
        });
        assert.equal(found.length, 1);
    });

    test('an address list is probed target by target', async () => {
        const socket = fakeSocket([]);
        await udpProbe({
            port: 43439,
            payload: PROBE,
            address: ['255.255.255.255', '172.16.23.255', '172.16.24.145'],
            ...FAST,
            createSocket: () => socket,
        });
        assert.deepEqual(
            socket.sent.map((entry) => entry.address),
            ['255.255.255.255', '172.16.23.255', '172.16.24.145'],
        );
    });

    test('a parser that throws does not take the scan down', async () => {
        const socket = fakeSocket([{message: reply, address: '192.168.1.130'}]);
        const found = await udpProbe({
            port: 1,
            payload: 'x',
            parse: () => {
                throw new Error('bad frame');
            },
            ...FAST,
            createSocket: () => socket,
        });
        assert.deepEqual(found, []);
    });
});

describe('serial ports', () => {
    // what /dev/serial/by-id looks like on a pi with a CUL and a zigbee stick plugged in
    const byId = {
        'usb-busware.de_CUL868-if00': '/dev/ttyACM0',
        'usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_abc123-if00-port0': '/dev/ttyUSB0',
    };
    const fakeFs = {
        readdirSync: (dir) => {
            if (dir === '/dev/serial/by-id') {
                return Object.keys(byId);
            }
            throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
        },
        realpathSync: (link) => byId[link.split('/').pop()],
    };

    test('lists the by-id names with the device node they point at', () => {
        const ports = listSerialPorts({deps: {fs: fakeFs}});
        assert.equal(ports.length, 2);
        assert.deepEqual(
            ports.find((port) => port.id.includes('busware')),
            {
                id: 'usb-busware.de_CUL868-if00',
                path: '/dev/serial/by-id/usb-busware.de_CUL868-if00',
                device: '/dev/ttyACM0',
            },
        );
    });

    test('a dangling symlink keeps the name', () => {
        const io = {
            readdirSync: (dir) => (dir === '/dev/serial/by-id' ? ['usb-busware.de_CUL868-if00'] : []),
            realpathSync: () => {
                throw new Error('ENOENT');
            },
        };
        const [port] = listSerialPorts({deps: {fs: io}});
        assert.equal(port.device, '/dev/serial/by-id/usb-busware.de_CUL868-if00');
    });

    test('without a by-id directory it falls back to /dev/cu.usb* (macOS)', () => {
        const io = {
            readdirSync: (dir) => {
                if (dir === '/dev') {
                    return ['null', 'cu.usbmodem14201', 'tty.usbmodem14201', 'cu.SLAB_USBtoUART'];
                }
                throw new Error('ENOENT');
            },
            realpathSync: (p) => p,
        };
        assert.deepEqual(
            listSerialPorts({deps: {fs: io}}).map((port) => port.id),
            ['cu.SLAB_USBtoUART', 'cu.usbmodem14201'],
        );
    });

    test('a host with no serial devices at all is empty, not an error', () => {
        const io = {
            readdirSync: () => {
                throw new Error('ENOENT');
            },
            realpathSync: (p) => p,
        };
        assert.deepEqual(listSerialPorts({deps: {fs: io}}), []);
    });

    test('serialMatches: every word must be in the name, case insensitive', () => {
        const cul = {id: 'usb-busware.de_CUL868-if00'};
        const zigbee = {id: 'usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_abc123-if00-port0'};
        assert.equal(serialMatches(cul, {contains: ['busware', 'CUL']}), true);
        assert.equal(serialMatches(zigbee, {contains: ['busware', 'CUL']}), false);
        // a CUL clone without busware in the name is not this stick
        assert.equal(serialMatches({id: 'usb-1a86_CUL_clone-if00'}, {contains: ['busware', 'CUL']}), false);
    });

    test('serialMatches: a regexp or a function work too', () => {
        const cul = {id: 'usb-busware.de_CUL868-if00'};
        assert.equal(serialMatches(cul, {match: /busware.*cul/i}), true);
        assert.equal(serialMatches(cul, {match: /nanoCUL/}), false);
        assert.equal(serialMatches(cul, {match: (port) => port.id.endsWith('-if00')}), true);
    });

    test('an empty spec matches everything', () => {
        assert.equal(serialMatches({id: 'anything'}), true);
    });
});

describe('discover: serial', () => {
    const fakeFs = {
        readdirSync: (dir) => {
            if (dir === '/dev/serial/by-id') {
                return ['usb-busware.de_CUL868-if00', 'usb-Prolific_USB-Serial-if00-port0'];
            }
            throw new Error('ENOENT');
        },
        realpathSync: (link) => (link.includes('busware') ? '/dev/ttyACM0' : '/dev/ttyUSB0'),
    };

    test('a plugged-in stick becomes a candidate keyed by its stable name', async () => {
        const found = await discover(
            {serial: {contains: ['busware', 'CUL']}},
            {timeout: 5, deps: {fs: fakeFs, createSocket: () => fakeSocket([])}},
        );
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '/dev/serial/by-id/usb-busware.de_CUL868-if00');
        assert.equal(found[0].device, '/dev/ttyACM0');
        assert.deepEqual(found[0].sources, ['serial']);
    });

    test('declared tcp ports do not drop it — a stick has none', async () => {
        // the hint of an adapter that speaks to either a local stick or a network CUL
        const found = await discover(
            {serial: {contains: ['busware', 'CUL']}, ports: {cuno: 2323}},
            {timeout: 5, deps: {fs: fakeFs, createSocket: () => fakeSocket([]), connect: fakeConnect([])}},
        );
        assert.equal(found.length, 1);
        assert.equal(found[0].services, undefined);
    });

    test('describe shows the stable name and the device node it points at', () => {
        assert.equal(
            describeEntry({
                address: '/dev/serial/by-id/usb-busware.de_CUL868-if00',
                device: '/dev/ttyACM0',
                sources: ['serial'],
            }),
            '/dev/serial/by-id/usb-busware.de_CUL868-if00  → /dev/ttyACM0  (serial)',
        );
    });

    test('network devices sort before serial ports', async () => {
        const socket = fakeSocket([
            {message: Buffer.from('HTTP/1.1 200 OK\r\nSERVER: x\r\n\r\n'), address: '192.168.1.9'},
        ]);
        const found = await discover(
            {serial: {contains: ['busware']}, ssdp: {}},
            {timeout: 5, deps: {fs: fakeFs, createSocket: () => socket}},
        );
        assert.deepEqual(
            found.map((entry) => entry.address),
            ['192.168.1.9', '/dev/serial/by-id/usb-busware.de_CUL868-if00'],
        );
    });
});

describe('arp / oui', () => {
    test('normalizeMac pads single-digit groups (the form macOS arp prints)', () => {
        assert.equal(normalizeMac('0:1A:22:3:44:5'), '00:1a:22:03:44:05');
    });

    test('ouiMatch ignores separators and case', () => {
        assert.equal(ouiMatch('00:1a:22:03:44:05', ['00-1A-22']), true);
        assert.equal(ouiMatch('00:1a:22:03:44:05', ['001a22']), true);
        assert.equal(ouiMatch('3c:6a:9d:00:00:01', ['00:1a:22']), false);
    });

    test('arpTable parses BSD arp -an output', async () => {
        const exec = async () => ({
            stdout: [
                '? (192.168.1.1) at 3c:6a:9d:1:2:3 on en0 ifscope [ethernet]',
                '? (192.168.1.130) at 0:1a:22:aa:bb:cc on en0 ifscope [ethernet]',
                '? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]',
            ].join('\n'),
        });
        const entries = await arpTable({exec});
        assert.equal(entries.length, 3);
        assert.deepEqual(entries[1], {address: '192.168.1.130', mac: '00:1a:22:aa:bb:cc'});
    });

    test('arpTable parses iproute2 output', async () => {
        let call = 0;
        const exec = async () => {
            call++;
            if (call === 1) {
                throw new Error('arp: command not found');
            }
            return {stdout: '192.168.1.130 dev eth0 lladdr 00:1a:22:aa:bb:cc REACHABLE'};
        };
        assert.deepEqual(await arpTable({exec}), [{address: '192.168.1.130', mac: '00:1a:22:aa:bb:cc'}]);
    });

    test('no arp command at all is empty, not an error', async () => {
        const exec = async () => {
            throw new Error('ENOENT');
        };
        assert.deepEqual(await arpTable({exec}), []);
    });
});

describe('discover', () => {
    const ssdpResponse = Buffer.from(
        'HTTP/1.1 200 OK\r\nST: urn:lge-com:service:webos-second-screen:1\r\nSERVER: WebOS\r\n\r\n',
    );

    test('merges the methods per address and records where each came from', async () => {
        const socket = fakeSocket([{message: ssdpResponse, address: '192.168.1.20'}]);
        const found = await discover(
            {ssdp: {st: 'urn:lge-com:service:webos-second-screen:1'}, ports: {webos: 3000}},
            {
                timeout: 5,
                deps: {createSocket: () => socket, connect: fakeConnect(['192.168.1.20:3000'])},
            },
        );
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '192.168.1.20');
        assert.deepEqual(found[0].sources, ['ssdp']);
        assert.deepEqual(found[0].services, {webos: true});
    });

    test('a candidate with none of the declared ports open is dropped', async () => {
        const socket = fakeSocket([{message: ssdpResponse, address: '192.168.1.20'}]);
        const found = await discover(
            {ssdp: {}, ports: {webos: 3000}},
            {timeout: 5, deps: {createSocket: () => socket, connect: fakeConnect([])}},
        );
        assert.deepEqual(found, []);
    });

    test('requirePort false keeps it, with the port state attached', async () => {
        const socket = fakeSocket([{message: ssdpResponse, address: '192.168.1.20'}]);
        const found = await discover(
            {ssdp: {}, ports: {webos: 3000}, requirePort: false},
            {timeout: 5, deps: {createSocket: () => socket, connect: fakeConnect([])}},
        );
        assert.equal(found.length, 1);
        assert.deepEqual(found[0].services, {webos: false});
    });

    test('the hint match function filters the answers', async () => {
        const socket = fakeSocket([{message: ssdpResponse, address: '192.168.1.20'}]);
        const found = await discover(
            {ssdp: {match: (headers) => headers.server === 'something else'}},
            {timeout: 5, deps: {createSocket: () => socket, connect: fakeConnect([])}},
        );
        assert.deepEqual(found, []);
    });

    test('probe() enriches a candidate and null drops it', async () => {
        const socket = fakeSocket([{message: ssdpResponse, address: '192.168.1.20'}]);
        const deps = {createSocket: () => socket, connect: fakeConnect([])};
        const enriched = await discover(
            {ssdp: {}, probe: async (address) => ({model: `OLED-${address.split('.').at(-1)}`})},
            {timeout: 5, deps},
        );
        assert.equal(enriched[0].model, 'OLED-20');
        const dropped = await discover({ssdp: {}, probe: async () => null}, {timeout: 5, deps});
        assert.deepEqual(dropped, []);
    });

    test('a probe that throws drops that candidate only', async () => {
        const socket = fakeSocket([
            {message: ssdpResponse, address: '192.168.1.20'},
            {message: ssdpResponse, address: '192.168.1.21'},
        ]);
        const found = await discover(
            {
                ssdp: {},
                probe: async (address) => {
                    if (address.endsWith('.20')) {
                        throw new Error('connection refused');
                    }
                    return {ok: true};
                },
            },
            {timeout: 5, deps: {createSocket: () => socket, connect: fakeConnect([])}},
        );
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '192.168.1.21');
    });

    test('the subnet sweep runs only when nothing else answered', async () => {
        const interfaces = () => ({
            en0: [{family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.192', internal: false}],
        });
        const deps = {
            createSocket: () => fakeSocket([]),
            connect: fakeConnect(['192.168.1.33:1999']),
            interfaces,
        };
        const found = await discover({ports: {ReGaHSS: 1999}}, {timeout: 5, deps});
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '192.168.1.33');
        assert.deepEqual(found[0].sources, ['sweep']);

        const noSweep = await discover({ports: {ReGaHSS: 1999}}, {timeout: 5, sweep: false, deps});
        assert.deepEqual(noSweep, []);
    });

    test('the oui method contributes what the arp cache knows', async () => {
        const exec = async () => ({stdout: '? (192.168.1.130) at 0:1a:22:aa:bb:cc on en0 [ethernet]'});
        const found = await discover(
            {oui: ['00:1a:22']},
            {timeout: 5, deps: {createSocket: () => fakeSocket([]), exec}},
        );
        assert.equal(found.length, 1);
        assert.equal(found[0].mac, '00:1a:22:aa:bb:cc');
        assert.deepEqual(found[0].sources, ['oui']);
    });

    test('the probe also goes to every local subnet broadcast, not only 255.255.255.255', async () => {
        // 255.255.255.255 is dropped by some stacks and never leaves the wire on others
        const socket = fakeSocket([]);
        const interfaces = () => ({
            eth0: [{family: 'IPv4', address: '172.16.23.226', netmask: '255.255.255.0', internal: false}],
        });
        await discover(
            {udp: {port: 43439, payload: 'x', parse: () => ({})}},
            {timeout: 5, deps: {createSocket: () => socket, interfaces}},
        );
        assert.deepEqual([...new Set(socket.sent.map((entry) => entry.address))], ['255.255.255.255', '172.16.23.255']);
    });

    test('--discover-address reaches a device a router away', async () => {
        const socket = fakeSocket([{message: Buffer.from('answer'), address: '172.16.24.145'}]);
        const interfaces = () => ({
            eth0: [{family: 'IPv4', address: '172.16.23.226', netmask: '255.255.255.0', internal: false}],
        });
        const found = await discover(
            {udp: {port: 43439, payload: 'x', parse: () => ({ccu: true})}},
            {
                timeout: 5,
                addresses: ['172.16.24.255'],
                deps: {createSocket: () => socket, interfaces},
            },
        );
        assert.ok(
            socket.sent.some((entry) => entry.address === '172.16.24.255'),
            'probed the other subnet',
        );
        assert.equal(found[0].address, '172.16.24.145');
        assert.equal(found[0].ccu, true);
    });

    test('a named address is a candidate of its own, confirmed by the declared ports', async () => {
        // the soundbar is one subnet away: no mDNS answer ever arrives, port 9741 is all there is
        const found = await discover(
            {mdns: {service: '_googlecast._tcp'}, ports: {control: 9741}},
            {
                timeout: 5,
                addresses: ['172.16.20.180'],
                deps: {
                    createSocket: () => fakeSocket([]),
                    connect: fakeConnect(['172.16.20.180:9741']),
                    interfaces: () => ({}),
                },
            },
        );
        assert.equal(found.length, 1);
        assert.equal(found[0].address, '172.16.20.180');
        assert.deepEqual(found[0].sources, ['address']);
        assert.deepEqual(found[0].services, {control: true});
    });

    test('a named address with nothing listening is not a device', async () => {
        const found = await discover(
            {mdns: {service: '_x._tcp'}, ports: {control: 9741}},
            {
                timeout: 5,
                addresses: ['172.16.20.181'],
                deps: {createSocket: () => fakeSocket([]), connect: fakeConnect([]), interfaces: () => ({})},
            },
        );
        assert.deepEqual(found, []);
    });

    test('requirePort false does not make a named address a device either', async () => {
        // hm2mqtt keeps a CCU whose ports are all closed — it answered the broadcast. An address
        // that answered nothing at all has proved nothing.
        const found = await discover(
            {udp: {port: 43439, payload: 'x', parse: () => ({})}, ports: {ReGa: 8181}, requirePort: false},
            {
                timeout: 5,
                addresses: ['172.16.24.145'],
                deps: {createSocket: () => fakeSocket([]), connect: fakeConnect([]), interfaces: () => ({})},
            },
        );
        assert.deepEqual(found, []);
    });

    test('an address that answers a method keeps that source, not "address"', async () => {
        const socket = fakeSocket([{message: Buffer.from('answer'), address: '172.16.24.145'}]);
        const found = await discover(
            {udp: {port: 43439, payload: 'x', parse: () => ({ccu: true})}, ports: {ReGa: 8181}, requirePort: false},
            {
                timeout: 5,
                addresses: ['172.16.24.145'],
                deps: {createSocket: () => socket, connect: fakeConnect([]), interfaces: () => ({})},
            },
        );
        assert.equal(found.length, 1);
        assert.deepEqual(found[0].sources, ['udp']);
    });

    test('--discover-address takes a range and sweeps it, whatever the sweep rule says', async () => {
        // the soundbar is on another VLAN and its address is unknown: sweep it for the port
        const socket = fakeSocket([{message: ssdpResponse, address: '192.168.1.20'}]);
        const interfaces = () => ({
            eth0: [{family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false}],
        });
        const found = await discover(
            {ssdp: {}, ports: {control: 9741}},
            {
                timeout: 5,
                addresses: ['172.16.20.0/29'],
                deps: {
                    createSocket: () => socket,
                    connect: fakeConnect(['172.16.20.5:9741', '192.168.1.20:9741']),
                    interfaces,
                },
            },
        );
        // ssdp answered, so the "auto" sweep of the local subnet is skipped — the range is not
        assert.deepEqual(
            found.map((entry) => entry.address),
            ['172.16.20.5', '192.168.1.20'],
        );
        assert.deepEqual(found[0].sources, ['sweep']);
    });

    test('the range broadcast is probed as well', async () => {
        const socket = fakeSocket([]);
        await discover(
            {udp: {port: 43439, payload: 'x', parse: () => ({})}},
            {timeout: 5, addresses: ['172.16.20.0/24'], deps: {createSocket: () => socket, interfaces: () => ({})}},
        );
        assert.ok(socket.sent.some((entry) => entry.address === '172.16.20.255'));
    });

    test('results are sorted by address', async () => {
        const socket = fakeSocket([
            {message: ssdpResponse, address: '192.168.1.100'},
            {message: ssdpResponse, address: '192.168.1.9'},
        ]);
        const found = await discover({ssdp: {}}, {timeout: 5, deps: {createSocket: () => socket}});
        assert.deepEqual(
            found.map((entry) => entry.address),
            ['192.168.1.9', '192.168.1.100'],
        );
    });

    test('a failing method does not fail the scan', async () => {
        const socket = fakeSocket([]);
        socket.bind = () => setImmediate(() => socket.emit('error', new Error('EACCES')));
        const found = await discover({ssdp: {}}, {timeout: 5, deps: {createSocket: () => socket}});
        assert.deepEqual(found, []);
    });
});

describe('discoverOne / --address auto', () => {
    const response = Buffer.from('HTTP/1.1 200 OK\r\nSERVER: WebOS\r\n\r\n');

    test('exactly one is returned', async () => {
        const socket = fakeSocket([{message: response, address: '192.168.1.20'}]);
        const device = await discoverOne({ssdp: {}}, {timeout: 5, deps: {createSocket: () => socket}});
        assert.equal(device.address, '192.168.1.20');
    });

    test('none is an error', async () => {
        await assert.rejects(
            () => discoverOne({ssdp: {}}, {timeout: 5, deps: {createSocket: () => fakeSocket([])}}),
            /no device found/,
        );
    });

    test('several refuse to guess and name the addresses', async () => {
        const socket = fakeSocket([
            {message: response, address: '192.168.1.20'},
            {message: response, address: '192.168.1.21'},
        ]);
        await assert.rejects(
            () => discoverOne({ssdp: {}}, {timeout: 5, deps: {createSocket: () => socket}}),
            /2 devices found \(192\.168\.1\.20, 192\.168\.1\.21\)/,
        );
    });
});

describe('autoAddress', () => {
    const response = Buffer.from('HTTP/1.1 200 OK\r\nSERVER: WebOS\r\n\r\n');

    test('takes --discover-timeout and --discover-address from the config', async () => {
        const socket = fakeSocket([{message: response, address: '172.16.24.145'}]);
        const interfaces = () => ({
            eth0: [{family: 'IPv4', address: '172.16.23.226', netmask: '255.255.255.0', internal: false}],
        });
        const address = await autoAddress(
            {ssdp: {}},
            {
                config: {discoverTimeout: 0.005, discoverAddress: ['172.16.24.255']},
                deps: {createSocket: () => socket, interfaces},
            },
        );
        assert.equal(address, '172.16.24.145');
        assert.ok(
            socket.sent.some((entry) => entry.address === '172.16.24.255'),
            'probed the named address',
        );
    });
});

describe('--discover output', () => {
    test('describe puts address, name, serial, open ports and sources on one line', () => {
        const line = describeEntry({
            address: '192.168.1.130',
            type: 'eQ3-HM-CCU2-App',
            serial: 'KEQ0112345',
            services: {ReGaHSS: true, 'BidCos-RF': true, CUxD: false},
            sources: ['udp', 'oui'],
        });
        assert.equal(line, '192.168.1.130  eQ3-HM-CCU2-App  serial KEQ0112345  [ReGaHSS BidCos-RF]  (udp+oui)');
    });

    test('runDiscovery prints one line per device and exits 0', async () => {
        const socket = fakeSocket([
            {message: Buffer.from('HTTP/1.1 200 OK\r\nSERVER: WebOS\r\n\r\n'), address: '10.0.0.5'},
        ]);
        const lines = [];
        let code;
        await runDiscovery({
            hint: {ssdp: {}},
            config: {discoverTimeout: 0.005},
            print: (line) => lines.push(line),
            exit: (value) => {
                code = value;
            },
            deps: {createSocket: () => socket},
        });
        assert.equal(code, 0);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^10\.0\.0\.5/);
    });

    test('--discover-json prints the raw objects', async () => {
        const socket = fakeSocket([
            {message: Buffer.from('HTTP/1.1 200 OK\r\nSERVER: WebOS\r\n\r\n'), address: '10.0.0.5'},
        ]);
        const lines = [];
        await runDiscovery({
            hint: {ssdp: {}},
            config: {discoverTimeout: 0.005, discoverJson: true},
            print: (line) => lines.push(line),
            exit: () => {},
            deps: {createSocket: () => socket},
        });
        const parsed = JSON.parse(lines[0]);
        assert.equal(parsed[0].address, '10.0.0.5');
    });

    test('nothing found says so', async () => {
        const lines = [];
        await runDiscovery({
            hint: {ssdp: {}},
            config: {discoverTimeout: 0.005},
            print: (line) => lines.push(line),
            exit: () => {},
            deps: {createSocket: () => fakeSocket([])},
        });
        assert.deepEqual(lines, ['nothing found']);
    });
});

/*
 * helpers
 */

/** Build a DNS-SD response message (PTR + SRV + TXT + A), the way a device answers a browse. */
function buildResponse(service, {instance, host, port, address, txt}) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2); // response, authoritative
    header.writeUInt16BE(4, 6); // four answers
    const records = [
        record(service, DNS_TYPE.PTR, encodeName(instance)),
        record(
            instance,
            DNS_TYPE.SRV,
            Buffer.concat([Buffer.from([0, 0, 0, 0, port >> 8, port & 0xff]), encodeName(host)]),
        ),
        record(
            instance,
            DNS_TYPE.TXT,
            Buffer.concat(
                Object.entries(txt).map(([key, value]) => {
                    const entry = Buffer.from(`${key}=${value}`);
                    return Buffer.concat([Buffer.from([entry.length]), entry]);
                }),
            ),
        ),
        record(host, DNS_TYPE.A, Buffer.from(address.split('.').map(Number))),
    ];
    return Buffer.concat([header, ...records]);
}

function record(name, type, rdata) {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(1, 2); // class IN
    head.writeUInt32BE(120, 4); // ttl
    head.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([encodeName(name), head, rdata]);
}
