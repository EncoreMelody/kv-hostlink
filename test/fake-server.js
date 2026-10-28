const net = require('net');

/**
 * Fake KEYENCE Host Link server for tests
 * handler(cmd) returns the response text (without CR LF), or { chunks: [...] } to send split packets,
 * or null for no response
 */
function startFakeHostLink(handler) {
    return new Promise((resolve) => {
        const received = [];
        const sockets = new Set();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            let buffer = '';
            socket.on('data', (chunk) => {
                buffer += chunk.toString('ascii');
                let idx;
                while ((idx = buffer.indexOf('\r')) !== -1) {
                    const cmd = buffer.substring(0, idx);
                    buffer = buffer.substring(idx + 1);
                    received.push(cmd);
                    const resp = handler(cmd, socket);
                    if (resp === null || resp === undefined) {
                        continue;
                    }
                    if (resp.chunks) {
                        resp.chunks.forEach((part, i) => setTimeout(() => socket.write(part), i * 15));
                    } else {
                        socket.write(resp + '\r\n');
                    }
                }
            });
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                received,
                close: () => new Promise((res) => {
                    sockets.forEach(s => s.destroy());
                    server.close(() => res());
                }),
            });
        });
    });
}

module.exports = { startFakeHostLink };
