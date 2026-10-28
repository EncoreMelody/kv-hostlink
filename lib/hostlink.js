'use strict';

/**
 * KEYENCE KV Host Link (upper link) protocol over TCP, ASCII frames.
 * Independent from FUXA: only depends on node 'net' and 'events'.
 *
 * Request:  <command>\r
 * Response: <data>\r\n   (errors: E0..E6)
 * The PLC handles one command at a time, so commands are queued and sent sequentially.
 * Reference: KEYENCE KV-NC1EP user manual, chapter 8 (commands p.8-13..8-17, errors p.8-36)
 */

const net = require('net');
const EventEmitter = require('events');

const DEFAULT_PORT = 8501;
const DEFAULT_TIMEOUT = 2500;

const ERRORS = {
    E0: 'Device number error',
    E1: 'Command error',
    E2: 'Program not registered',
    E4: 'Write protected',
    E5: 'Unit error',
    E6: 'No comment',
};

const MODES = { 0: 'PROGRAM', 1: 'RUN' };

// ?K response (p.8-13)
const MODELS = {
    '51': 'KV-3000', '52': 'KV-5000', '53': 'KV-5500', '54': 'KV-7300', '55': 'KV-7500',
    '128': 'KV-NC32T', '132': 'KV-N60', '133': 'KV-N40', '134': 'KV-N24',
};

class HostLinkError extends Error {
    constructor(code, command) {
        super(`${command} -> ${code} ${ERRORS[code] || 'Unknown error'}`);
        this.name = 'HostLinkError';
        this.code = code;
        this.command = command;
    }
}

class HostLinkTimeoutError extends Error {
    constructor(command, timeout) {
        super(`${command} -> no response within ${timeout} ms`);
        this.name = 'HostLinkTimeoutError';
        this.command = command;
    }
}

class HostLinkClient extends EventEmitter {
    /**
     * @param {{host: string, port?: number, timeout?: number}} options
     */
    constructor(options) {
        super();
        this.host = options.host;
        this.port = options.port || DEFAULT_PORT;
        this.timeout = options.timeout || DEFAULT_TIMEOUT;
        this.socket = null;
        this.connected = false;
        this.queue = [];
        this.current = null;
        this.buffer = '';
    }

    connect() {
        return new Promise((resolve, reject) => {
            if (this.socket) {
                this.close();
            }
            const socket = net.createConnection({ host: this.host, port: this.port });
            this.socket = socket;
            this.buffer = '';
            const timer = setTimeout(() => {
                socket.destroy(new HostLinkTimeoutError('connect', this.timeout));
            }, this.timeout);
            socket.once('connect', () => {
                clearTimeout(timer);
                socket.setNoDelay(true);
                socket.setKeepAlive(true, 10000);
                this.connected = true;
                resolve();
            });
            socket.on('data', (chunk) => this._onData(chunk));
            socket.on('error', (err) => {
                clearTimeout(timer);
                if (!this.connected) {
                    reject(err);
                }
                this.emit('error', err);
            });
            socket.on('close', () => {
                clearTimeout(timer);
                if (this.socket === socket) {
                    this._onClose();
                }
            });
        });
    }

    close() {
        const socket = this.socket;
        this._onClose();
        if (socket) {
            socket.removeAllListeners('data');
            socket.on('error', () => {});
            socket.destroy();
        }
    }

    isConnected() {
        return this.connected;
    }

    /**
     * Send a raw command (without CR), resolve with the response text (without CR LF)
     */
    command(cmd) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                return reject(new Error('not connected'));
            }
            this.queue.push({ cmd, resolve, reject });
            this._next();
        });
    }

    /**
     * RDS <dev><no>[.fmt] <count>, return numbers (bit devices 0/1, .H parsed as hex)
     */
    async readWords(dev, no, count, fmt) {
        const cmd = `RDS ${dev}${no}${fmt ? '.' + fmt : ''} ${count}`;
        const resp = await this.command(cmd);
        const tokens = resp.trim().split(/\s+/);
        if (tokens.length !== count) {
            throw new Error(`${cmd} -> expected ${count} values, received ${tokens.length}`);
        }
        return tokens.map(tok => parseToken(tok, fmt, cmd));
    }

    /**
     * WR (single) or WRS (multiple) <dev><no>[.fmt] values
     */
    async writeWords(dev, no, values, fmt) {
        values = Array.isArray(values) ? values : [values];
        const addr = `${dev}${no}${fmt ? '.' + fmt : ''}`;
        const data = values.map(v => formatToken(v, fmt)).join(' ');
        const cmd = values.length === 1 ? `WR ${addr} ${data}` : `WRS ${addr} ${values.length} ${data}`;
        const resp = await this.command(cmd);
        if (resp.trim() !== 'OK') {
            throw new Error(`${cmd} -> unexpected response '${resp}'`);
        }
    }

    /**
     * ?M operating mode: 0 = PROGRAM, 1 = RUN
     */
    async getMode() {
        const resp = (await this.command('?M')).trim();
        const code = parseInt(resp, 10);
        return { code, name: MODES[code] || 'UNKNOWN' };
    }

    /**
     * ?K model code, e.g. 132 = KV-N60
     */
    async getModel() {
        const code = (await this.command('?K')).trim();
        return { code, name: MODELS[code] || 'UNKNOWN' };
    }

    _next() {
        if (this.current || !this.queue.length) {
            return;
        }
        const job = this.queue.shift();
        this.current = job;
        job.timer = setTimeout(() => {
            // a late answer would desynchronize the stream: drop the connection
            this.current = null;
            job.reject(new HostLinkTimeoutError(job.cmd, this.timeout));
            this.close();
        }, this.timeout);
        this.socket.write(job.cmd + '\r', 'ascii');
    }

    _onData(chunk) {
        this.buffer += chunk.toString('ascii');
        let idx;
        while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
            const line = this.buffer.substring(0, idx);
            this.buffer = this.buffer.substring(idx + 2);
            const job = this.current;
            if (!job) {
                continue;   // unsolicited data, ignore
            }
            clearTimeout(job.timer);
            this.current = null;
            if (ERRORS[line.trim()]) {
                job.reject(new HostLinkError(line.trim(), job.cmd));
            } else {
                job.resolve(line);
            }
            this._next();
        }
    }

    _onClose() {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.buffer = '';
        const pending = this.current ? [this.current, ...this.queue] : this.queue;
        this.current = null;
        this.queue = [];
        pending.forEach(job => {
            clearTimeout(job.timer);
            job.reject(new Error('connection closed'));
        });
        if (wasConnected) {
            this.emit('close');
        }
    }
}

function parseToken(tok, fmt, cmd) {
    const value = (fmt === 'H') ? parseInt(tok, 16) : parseInt(tok, 10);
    if (Number.isNaN(value)) {
        throw new Error(`${cmd} -> invalid value '${tok}'`);
    }
    return value;
}

function formatToken(value, fmt) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        throw new Error(`invalid value '${value}'`);
    }
    if (fmt === 'H') {
        return (Math.trunc(num) & 0xFFFF).toString(16).toUpperCase();
    }
    return String(Math.trunc(num));
}

module.exports = {
    HostLinkClient,
    HostLinkError,
    HostLinkTimeoutError,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT,
    ERRORS,
    MODES,
    MODELS,
};
