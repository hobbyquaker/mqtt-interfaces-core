/**
 * Home Assistant MQTT discovery, device-based (HA >= 2024.11):
 * https://www.home-assistant.io/integrations/mqtt/#device-discovery-payload
 *
 * D-13: the discovery payload is *our* entity description format; HA is one consumer. The core
 * provides the scaffold (id, topic, availability via <name>/connected, origin, common entity
 * fields); the adapter supplies the device block and the entity map. Builders are pure functions.
 */

/** Stable device/unique-id base: <adapter>_<instance or device uuid>, sanitised. */
export function discoveryId(adapterName, instance) {
    return `${adapterName}_${String(instance).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function discoveryTopic(prefix, id) {
    return `${prefix}/device/${id}/config`;
}

/**
 * Availability from <name>/connected: online when the value is >= minimum.
 * 2 = device connected (default), 1 = only the bridge (e.g. a power switch that wakes the device).
 */
export function availability(name, minimum = 2) {
    return [
        {
            t: `${name}/connected`,
            avty_tpl: `{{ 'online' if (value | int(0)) >= ${minimum} else 'offline' }}`,
        },
    ];
}

/** Platforms without a state topic. */
const STATELESS = new Set(['button', 'notify', 'scene', 'tag']);

/**
 * Common fields of one entity. Adds the platform-specific fields you pass in `extra` verbatim.
 *
 * @param {object} e
 * @param {string} e.id discovery id (from discoveryId)
 * @param {string} e.name instance name / topic prefix
 * @param {string} e.item status/set item (snake_case)
 * @param {string} e.platform HA platform: switch, number, select, sensor, binary_sensor, button, notify, ...
 * @param {string} e.label entity name shown in HA
 * @param {string} [e.uid] unique id suffix override (default item)
 * @param {string} [e.icon] mdi:...
 * @param {'config' | 'diagnostic'} [e.category]
 * @param {boolean} [e.jsonPayloads] status payloads are {val, ts, lc}
 * @param {boolean} [e.command] add cmd_t <name>/set/<item>
 * @param {object} [e.extra] additional HA fields (pl_on, min, options, val_tpl, avty, ...)
 */
export function entity({
    id,
    name,
    item,
    platform,
    label,
    uid,
    icon,
    category,
    jsonPayloads = true,
    command,
    extra = {},
}) {
    const stateless = STATELESS.has(platform);
    return {
        p: platform,
        uniq_id: `${id}_${(uid || item).replace(/\//g, '_')}`,
        name: label,
        ...(!stateless && {stat_t: `${name}/status/${item}`}),
        ...(!stateless && jsonPayloads && {val_tpl: '{{ value_json.val }}'}),
        ...(command && {cmd_t: `${name}/set/${item}`}),
        ...(icon && {ic: icon}),
        ...(category && {ent_cat: category}),
        ...extra,
    };
}

/**
 * The full device discovery message.
 *
 * @param {object} d
 * @param {{name: string, version: string, homepage?: string}} d.pkg adapter package (origin block)
 * @param {string} d.name instance name / topic prefix
 * @param {string} [d.prefix] discovery prefix (default homeassistant)
 * @param {string} [d.id] default discoveryId(pkg.name, name)
 * @param {object} [d.device] extra device fields: mf, mdl, sw, hw, cns, ... (ids/name are added)
 * @param {Object<string, object>} d.components entity map (key → entity())
 * @param {number} [d.availabilityMin] default 2
 * @returns {{topic: string, payload: object}}
 */
export function devicePayload({pkg, name, prefix = 'homeassistant', id, device = {}, components, availabilityMin = 2}) {
    const devId = id || discoveryId(pkg.name, name);
    const payload = {
        dev: {ids: [devId], name, ...device},
        o: {name: pkg.name, sw: pkg.version, ...(pkg.homepage && {url: pkg.homepage})},
        avty: availability(name, availabilityMin),
        qos: 0,
        cmps: components,
    };
    return {topic: discoveryTopic(prefix, devId), payload};
}
