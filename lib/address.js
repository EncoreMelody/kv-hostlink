'use strict';

/**
 * KEYENCE KV device address parser and read planner (Host Link)
 *
 * Tag address: <device><number>[.<format>]   e.g. DM100, DM100.S, DM200.L, MR1000, R500, TC0, W1F.H
 *   formats: U 16bit unsigned, S 16bit signed, H 16bit hex, D 32bit unsigned, L 32bit signed,
 *            F 32bit float (read/written as .D and reinterpreted, IEEE 754 low word first)
 *   bit devices without format are read as bit (0/1)
 */

// numbering: dec = decimal number, chbit = channel + 2 digit bit (00-15), hex = hexadecimal
const DEVICES = {
    R:  { kind: 'bit', numbering: 'chbit' },
    MR: { kind: 'bit', numbering: 'chbit' },
    LR: { kind: 'bit', numbering: 'chbit' },
    CR: { kind: 'bit', numbering: 'chbit' },
    B:  { kind: 'bit', numbering: 'hex' },
    VB: { kind: 'bit', numbering: 'hex' },
    T:  { kind: 'bit', numbering: 'dec', bitOnly: true },
    C:  { kind: 'bit', numbering: 'dec', bitOnly: true },
    DM: { kind: 'word', numbering: 'dec' },
    EM: { kind: 'word', numbering: 'dec' },
    FM: { kind: 'word', numbering: 'dec' },
    ZF: { kind: 'word', numbering: 'dec' },
    TM: { kind: 'word', numbering: 'dec' },
    CM: { kind: 'word', numbering: 'dec' },
    VM: { kind: 'word', numbering: 'dec' },
    Z:  { kind: 'word', numbering: 'dec' },
    W:  { kind: 'word', numbering: 'hex' },
    // timer/counter current and set values: one 32bit element per number
    TC: { kind: 'word', numbering: 'dec', perNumber: true, defaultFormat: 'D' },
    TS: { kind: 'word', numbering: 'dec', perNumber: true, defaultFormat: 'D' },
    CC: { kind: 'word', numbering: 'dec', perNumber: true, defaultFormat: 'D' },
    CS: { kind: 'word', numbering: 'dec', perNumber: true, defaultFormat: 'D' },
};
const DEVICE_NAMES = Object.keys(DEVICES).sort((a, b) => b.length - a.length);

// max: max count of a RDS command (p.8-17)
const FORMATS = {
    BIT: { wire: '', words: 1, max: 1000, type: 'Bool' },
    U: { wire: 'U', words: 1, max: 1000, min: 0, maxValue: 0xFFFF, type: 'UInt16' },
    S: { wire: 'S', words: 1, max: 1000, min: -0x8000, maxValue: 0x7FFF, type: 'Int16' },
    H: { wire: 'H', words: 1, max: 1000, min: 0, maxValue: 0xFFFF, type: 'Hex16' },
    D: { wire: 'D', words: 2, max: 500, min: 0, maxValue: 0xFFFFFFFF, type: 'UInt32' },
    L: { wire: 'L', words: 2, max: 500, min: -0x80000000, maxValue: 0x7FFFFFFF, type: 'Int32' },
    F: { wire: 'D', words: 2, max: 500, type: 'Float32' },
};

/**
 * Parse a tag address
 * @returns {{device, format, wire, index, stride, kind, type, text}}
 *   index is the position in the device space used to merge reads (bit index, channel or word number)
 */
function parseAddress(address) {
    if (typeof address !== 'string' || !address.trim()) {
        throw new Error('empty address');
    }
    const text = address.trim().toUpperCase();
    const dot = text.indexOf('.');
    const body = dot === -1 ? text : text.substring(0, dot);
    const fmtText = dot === -1 ? '' : text.substring(dot + 1);

    const device = DEVICE_NAMES.find(name => body.startsWith(name) && body.length > name.length);
    if (!device) {
        throw new Error(`unknown device in '${address}'`);
    }
    const def = DEVICES[device];
    const numText = body.substring(device.length);
    if (fmtText && !FORMATS[fmtText] || fmtText === 'BIT') {
        throw new Error(`unknown format '.${fmtText}' in '${address}'`);
    }
    const format = fmtText || def.defaultFormat || (def.kind === 'bit' ? 'BIT' : 'U');
    const fmt = FORMATS[format];
    if (def.bitOnly && format !== 'BIT') {
        throw new Error(`device ${device} supports only bit access '${address}'`);
    }

    let number;
    if (def.numbering === 'hex') {
        if (!/^[0-9A-F]+$/.test(numText)) {
            throw new Error(`invalid number in '${address}'`);
        }
        number = parseInt(numText, 16);
    } else {
        if (!/^\d+$/.test(numText)) {
            throw new Error(`invalid number in '${address}'`);
        }
        number = parseInt(numText, 10);
    }

    let index = number;
    if (def.numbering === 'chbit') {
        const channel = Math.floor(number / 100);
        const bit = number % 100;
        if (bit > 15) {
            throw new Error(`invalid bit number in '${address}' (00-15)`);
        }
        if (format === 'BIT') {
            index = channel * 16 + bit;
        } else if (bit !== 0) {
            throw new Error(`word access of ${device} must start at bit 00 '${address}'`);
        } else {
            index = channel;
        }
    } else if (def.kind === 'bit' && format !== 'BIT') {
        // hex bit device (B, VB) as word: 16 bits per word
        if (number % 16 !== 0) {
            throw new Error(`word access of ${device} must start at a multiple of 16 '${address}'`);
        }
        index = number / 16;
    }
    const stride = (format === 'BIT' || def.perNumber) ? 1 : fmt.words;
    return { device, format, wire: fmt.wire, index, stride, kind: def.kind, type: fmt.type, text: formatAddress(device, format, index) };
}

/**
 * Address text of the device at index (inverse of parseAddress), without format suffix
 */
function formatAddress(device, format, index) {
    const def = DEVICES[device];
    if (def.numbering === 'chbit') {
        if (format === 'BIT') {
            return `${device}${Math.floor(index / 16)}${String(index % 16).padStart(2, '0')}`;
        }
        return `${device}${index}00`;
    }
    if (def.numbering === 'hex') {
        const num = (def.kind === 'bit' && format !== 'BIT') ? index * 16 : index;
        return `${device}${num.toString(16).toUpperCase()}`;
    }
    return `${device}${index}`;
}

/**
 * Merge the tags in RDS blocks: same device and format, aligned to the element size,
 * gap between requested elements <= maxGap and count <= format max
 * @param {Array<{id: string, addr: object}>} entries parsed addresses
 * @returns {Array<{device, format, wire, start, count, items: Array<{id, offset}>}>}
 */
function buildReadPlan(entries, options) {
    const maxGap = (options && Number.isInteger(options.maxGap)) ? options.maxGap : 10;
    const groups = {};
    entries.forEach(entry => {
        const key = `${entry.addr.device}|${entry.addr.format}`;
        (groups[key] = groups[key] || []).push(entry);
    });
    const blocks = [];
    Object.values(groups).forEach(group => {
        group.sort((a, b) => a.addr.index - b.addr.index);
        let block = null;
        group.forEach(entry => {
            const { index, stride } = entry.addr;
            const max = FORMATS[entry.addr.format].max;
            if (block) {
                const delta = index - block.startIndex;
                const aligned = delta % stride === 0;
                const gap = (index - block.endIndex) / stride - 1;
                if (aligned && gap <= maxGap && delta / stride + 1 <= max) {
                    block.endIndex = Math.max(block.endIndex, index);
                    block.items.push({ id: entry.id, offset: delta / stride });
                    return;
                }
            }
            block = {
                device: entry.addr.device,
                format: entry.addr.format,
                wire: entry.addr.wire,
                startIndex: index,
                endIndex: index,
                stride,
                items: [{ id: entry.id, offset: 0 }],
            };
            blocks.push(block);
        });
    });
    return blocks.map(b => ({
        device: b.device,
        format: b.format,
        wire: b.wire,
        start: formatAddress(b.device, b.format, b.startIndex).substring(b.device.length),
        count: (b.endIndex - b.startIndex) / b.stride + 1,
        items: b.items,
    }));
}

/**
 * Raw value received (number) to tag value
 */
function decodeValue(raw, format) {
    if (format === 'F') {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(raw >>> 0);
        return buf.readFloatBE(0);
    }
    return raw;
}

/**
 * Tag value to raw value to send, check the range of the format
 */
function encodeValue(value, format) {
    if (format === 'BIT') {
        if (typeof value === 'string') {
            const str = value.trim().toLowerCase();
            return (str === 'true' || (str !== '' && Number(str) !== 0 && !Number.isNaN(Number(str)))) ? 1 : 0;
        }
        return value ? 1 : 0;
    }
    const num = Number(value);
    if (value === null || value === '' || !Number.isFinite(num)) {
        throw new Error(`invalid value '${value}'`);
    }
    if (format === 'F') {
        const buf = Buffer.alloc(4);
        buf.writeFloatBE(num);
        return buf.readUInt32BE(0);
    }
    const fmt = FORMATS[format];
    const int = Math.round(num);
    if (int < fmt.min || int > fmt.maxValue) {
        throw new Error(`value ${value} out of range for .${format} (${fmt.min}..${fmt.maxValue})`);
    }
    return int;
}

module.exports = {
    DEVICES,
    FORMATS,
    parseAddress,
    formatAddress,
    buildReadPlan,
    decodeValue,
    encodeValue,
};
