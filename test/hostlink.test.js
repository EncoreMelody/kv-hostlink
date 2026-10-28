const { HostLinkClient, HostLinkError, HostLinkTimeoutError } = require('../lib/hostlink');
const { startFakeHostLink } = require('./fake-server');

describe('KEYENCE Host Link protocol', () => {
    let server;
    let client;

    before(async () => {
        const chai = await import('chai');
        global.expect = chai.expect;
    });

    afterEach(async () => {
        if (client) {
            client.close();
            client = null;
        }
        if (server) {
            await server.close();
            server = null;
        }
    });

    async function connect(handler, timeout = 500) {
        server = await startFakeHostLink(handler);
        client = new HostLinkClient({ host: '127.0.0.1', port: server.port, timeout });
        client.on('error', () => {});
        await client.connect();
    }

    // responses recorded on KV-N60AT + KV-NC1EP
    const plc = {
        'RDS DM100.U 5': '04662 00127 00000 00000 00000',
        'RDS DM100.S 2': '+04662 +00127',
        'RDS DM100.H 2': '1236 007F',
        'RDS DM100.L 1': '+0008327734',
        'RDS MR0 5': '0 0 0 0 0',
        'RDS TC0 1': '4294967295',
        'WR DM100.U 4662': 'OK',
        'WRS DM100.U 2 1 2': 'OK',
        'WR DM100.S -1': 'OK',
        'WR DM100.H 7F': 'OK',
        '?M': '1',
        '?K': '132',
        'RDS DM32768 1': 'E0',
        'RDS EM0 1': 'E1',
        'WR DM0.U 1': 'E4',
    };

    it('reads words in all formats', async () => {
        await connect(cmd => plc[cmd] || 'E1');
        expect(await client.readWords('DM', 100, 5, 'U')).to.deep.equal([4662, 127, 0, 0, 0]);
        expect(await client.readWords('DM', 100, 2, 'S')).to.deep.equal([4662, 127]);
        expect(await client.readWords('DM', 100, 2, 'H')).to.deep.equal([0x1236, 0x7F]);
        expect(await client.readWords('DM', 100, 1, 'L')).to.deep.equal([8327734]);
        expect(await client.readWords('MR', 0, 5, '')).to.deep.equal([0, 0, 0, 0, 0]);
        expect(await client.readWords('TC', 0, 1, '')).to.deep.equal([4294967295]);
    });

    it('parses negative signed values', async () => {
        await connect(() => '-00001 -32768 +32767');
        expect(await client.readWords('DM', 0, 3, 'S')).to.deep.equal([-1, -32768, 32767]);
    });

    it('writes with WR and WRS', async () => {
        await connect(cmd => plc[cmd] || 'E1');
        await client.writeWords('DM', 100, [4662], 'U');
        await client.writeWords('DM', 100, [1, 2], 'U');
        await client.writeWords('DM', 100, [-1], 'S');
        await client.writeWords('DM', 100, [0x7F], 'H');
        expect(server.received).to.deep.equal(['WR DM100.U 4662', 'WRS DM100.U 2 1 2', 'WR DM100.S -1', 'WR DM100.H 7F']);
    });

    it('reads mode and model', async () => {
        await connect(cmd => plc[cmd] || 'E1');
        expect(await client.getMode()).to.deep.equal({ code: 1, name: 'RUN' });
        expect(await client.getModel()).to.deep.equal({ code: '132', name: 'KV-N60' });
    });

    it('maps E0..E6 to HostLinkError', async () => {
        const codes = ['E0', 'E1', 'E2', 'E4', 'E5', 'E6'];
        await connect(cmd => codes[parseInt(cmd.split(' ')[1].substring(2), 10)]);
        for (let i = 0; i < codes.length; i++) {
            try {
                await client.readWords('DM', i, 1, 'U');
                expect.fail('should throw');
            } catch (err) {
                expect(err).to.be.instanceOf(HostLinkError);
                expect(err.code).to.equal(codes[i]);
            }
        }
    });

    it('rejects a write refused by the PLC', async () => {
        await connect(cmd => plc[cmd] || 'E1');
        try {
            await client.writeWords('DM', 0, [1], 'U');
            expect.fail('should throw');
        } catch (err) {
            expect(err.code).to.equal('E4');
        }
    });

    it('rebuilds a response split in several TCP packets', async () => {
        await connect(() => ({ chunks: ['04662 00', '127 000', '00\r', '\n'] }));
        expect(await client.readWords('DM', 100, 3, 'U')).to.deep.equal([4662, 127, 0]);
    });

    it('rejects when the count of values does not match', async () => {
        await connect(() => '00001 00002');
        try {
            await client.readWords('DM', 0, 3, 'U');
            expect.fail('should throw');
        } catch (err) {
            expect(err.message).to.contain('expected 3 values');
        }
    });

    it('times out and closes the connection', async () => {
        await connect(() => null, 100);
        let closed = false;
        client.on('close', () => { closed = true; });
        try {
            await client.command('?M');
            expect.fail('should throw');
        } catch (err) {
            expect(err).to.be.instanceOf(HostLinkTimeoutError);
        }
        expect(closed).to.equal(true);
        expect(client.isConnected()).to.equal(false);
    });

    it('queues concurrent commands and sends them one at a time', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        await connect((cmd, socket) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            setTimeout(() => {
                inFlight--;
                socket.write(cmd.split(' ')[1] + '\r\n');
            }, 10);
            return null;
        });
        const results = await Promise.all(['A1', 'A2', 'A3', 'A4'].map(arg => client.command(`X ${arg}`)));
        expect(results).to.deep.equal(['A1', 'A2', 'A3', 'A4']);
        expect(maxInFlight).to.equal(1);
    });

    it('rejects pending commands when the PLC closes the connection', async () => {
        await connect((cmd, socket) => {
            socket.destroy();
            return null;
        });
        try {
            await client.command('?M');
            expect.fail('should throw');
        } catch (err) {
            expect(err.message).to.contain('closed');
        }
        expect(client.isConnected()).to.equal(false);
    });

    it('fails to connect to a closed port', async () => {
        server = await startFakeHostLink(() => null);
        const port = server.port;
        await server.close();
        server = null;
        client = new HostLinkClient({ host: '127.0.0.1', port, timeout: 500 });
        client.on('error', () => {});
        try {
            await client.connect();
            expect.fail('should throw');
        } catch (err) {
            expect(err.code).to.equal('ECONNREFUSED');
        }
    });
});
