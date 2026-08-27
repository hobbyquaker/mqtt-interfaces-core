/**
 * MQTT payload helpers (mqtt-smarthome conventions).
 */

/**
 * Converts an incoming MQTT payload (Buffer or string) to a JS value.
 * Accepts plain values (numbers, booleans, strings), JSON objects/arrays and
 * mqtt-smarthome style JSON {val: ...} (unwrapped to the value).
 * Returns undefined for empty payloads.
 */
export function parsePayload(payload) {
    const trimmed = String(payload).trim();
    if (trimmed === '') {
        return undefined;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'val' in parsed) {
                return parsed.val;
            }
            return parsed;
        } catch {
            // not JSON, treat as string
        }
    }
    if (trimmed === 'true') {
        return true;
    }
    if (trimmed === 'false') {
        return false;
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return Number(trimmed);
    }
    return trimmed;
}

/**
 * Interprets a parsed payload as boolean: true/false, 1/0, "on"/"off", "yes"/"no".
 * Returns undefined if the value is not recognized.
 */
export function toBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (['true', '1', 'on', 'yes'].includes(s)) {
            return true;
        }
        if (['false', '0', 'off', 'no'].includes(s)) {
            return false;
        }
    }
    return undefined;
}

/**
 * Interprets a parsed payload as integer within [min, max] (rounded, clamped).
 * Returns undefined if not a finite number.
 */
export function clampInt(value, min, max) {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) {
        return undefined;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Volume 0..100 (integer). Returns undefined if not a number. */
export function toVolume(value) {
    return clampInt(value, 0, 100);
}

/** {val, ts, lc} plus the extra fields; extra never overrides the three. */
function jsonPayload({val, ts, lc, extra}) {
    const payload = {val, ts, lc};
    if (extra && typeof extra === 'object') {
        for (const key of Object.keys(extra)) {
            if (!(key in payload)) {
                payload[key] = extra[key];
            }
        }
    }
    return payload;
}

/**
 * Remembers the last value per item and produces outgoing status payloads,
 * either plain or as {val, ts, lc} JSON (plus optional extra fields).
 */
export class StatusTracker {
    /**
     * @param {object} options
     * @param {boolean} [options.json] emit {val, ts, lc} objects instead of plain values
     * @param {() => number} [options.now] clock, for tests
     */
    constructor({json = false, now = Date.now} = {}) {
        this.json = json;
        this.now = now;
        this.state = new Map();
    }

    /** Last known value of an item (undefined if never seen). */
    get(item) {
        const entry = this.state.get(item);
        return entry && entry.val;
    }

    /** Whether the item was last published retained (non-retained items are events). */
    isRetained(item) {
        const entry = this.state.get(item);
        return entry ? entry.retain !== false : false;
    }

    /** Payload of an already tracked item (for re-publishing), undefined if unknown. */
    payload(item) {
        const entry = this.state.get(item);
        if (!entry) {
            return undefined;
        }
        return this.json ? jsonPayload(entry) : entry.val;
    }

    /**
     * Record a new value and return what to publish. Non-retained items (events such as a spoken
     * command or a progress tick) are remembered for get()/discovery but must not be re-published
     * after a reconnect, so the retain flag is kept with the value.
     * @param {string} item
     * @param {*} val
     * @param {{retain?: boolean, extra?: object, ts?: number, lc?: number}} [options]
     *        `extra`: additional fields of the JSON payload (an adapter's own meta data next to
     *        val/ts/lc; ignored for plain payloads); `ts`/`lc`: device-side timestamps (ms) that
     *        replace the tracker's clock for values that carry their own time
     * @returns {{payload: *, changed: boolean}}
     */
    update(item, val, {retain = true, extra, ts, lc} = {}) {
        ts = ts ?? this.now();
        const previous = this.state.get(item);
        const changed = !previous || JSON.stringify(previous.val) !== JSON.stringify(val);
        lc = lc ?? (changed ? ts : previous.lc);
        const entry = {val, ts, lc, retain, extra};
        this.state.set(item, entry);
        return {payload: this.json ? jsonPayload(entry) : val, changed};
    }

    /** Forget an item (e.g. when it no longer applies). Returns true if it was known. */
    delete(item) {
        return this.state.delete(item);
    }
}
