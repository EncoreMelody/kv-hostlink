const { parseAddress, buildReadPlan, decodeValue, encodeValue } = require('../lib/address');

describe('KEYENCE address and read plan', () => {
    before(async () => {
        const chai = await import('chai');
        global.expect = chai.expect;
    });

    const plan = (list, options) => buildReadPlan(list.map((text, i) => ({ id: `t${i}`, addr: parseAddress(text) })), options);

    describe('parseAddress', () => {
        it('parses word devices with default and explicit formats', () => {
            expect(parseAddress('DM100')).to.include({ device: 'DM', format: 'U', wire: 'U', index: 100, stride: 1, type: 'UInt16', text: 'DM100' });
            expect(parseAddress('dm100.s')).to.include({ device: 'DM', format: 'S', type: 'Int16' });
            expect(parseAddress('DM200.L')).to.include({ format: 'L', wire: 'L', stride: 2, type: 'Int32' });
            expect(parseAddress('DM200.D')).to.include({ format: 'D', stride: 2 });
            expect(parseAddress('DM300.F')).to.include({ format: 'F', wire: 'D', stride: 2, type: 'Float32' });
            expect(parseAddress('EM0.H')).to.include({ device: 'EM', format: 'H' });
            expect(parseAddress('W1F')).to.include({ device: 'W', index: 0x1F, text: 'W1F' });
        });

        it('uses 32bit per number for timer and counter values', () => {
            expect(parseAddress('TC0')).to.include({ device: 'TC', format: 'D', stride: 1 });
            expect(parseAddress('CS5.U')).to.include({ device: 'CS', format: 'U', stride: 1 });
        });

        it('parses channel + bit devices', () => {
            expect(parseAddress('MR1000')).to.include({ device: 'MR', format: 'BIT', wire: '', index: 160, type: 'Bool', text: 'MR1000' });
            expect(parseAddress('MR015')).to.include({ index: 15, text: 'MR015' });
            expect(parseAddress('R500')).to.include({ device: 'R', index: 80 });
            expect(parseAddress('CR2002')).to.include({ device: 'CR', index: 20 * 16 + 2 });
            expect(parseAddress('MR1000.U')).to.include({ format: 'U', index: 10, text: 'MR1000' });
        });

        it('does not confuse device prefixes', () => {
            expect(parseAddress('CM10').device).to.equal('CM');
            expect(parseAddress('CR10').device).to.equal('CR');
            expect(parseAddress('C10').device).to.equal('C');
            expect(parseAddress('TM5').device).to.equal('TM');
            expect(parseAddress('T5').device).to.equal('T');
            expect(parseAddress('VB1F').device).to.equal('VB');
        });

        it('rejects invalid addresses', () => {
            const invalid = ['', 'XX0', 'DM', 'DM1A', 'DM100.Q', 'DM100.BIT', 'MR16', 'MR1001.U', 'T0.U', 'B1.U', 'W1G'];
            invalid.forEach(text => expect(() => parseAddress(text), text).to.throw());
        });
    });

    describe('buildReadPlan', () => {
        it('merges close addresses of same device and format', () => {
            const blocks = plan(['DM100', 'DM101', 'DM105', 'DM200']);
            expect(blocks).to.have.length(2);
            expect(blocks[0]).to.include({ device: 'DM', start: '100', count: 6, wire: 'U' });
            expect(blocks[0].items).to.deep.equal([{ id: 't0', offset: 0 }, { id: 't1', offset: 1 }, { id: 't2', offset: 5 }]);
            expect(blocks[1]).to.include({ start: '200', count: 1 });
        });

        it('respects the max gap', () => {
            expect(plan(['DM0', 'DM11'])).to.have.length(1);
            expect(plan(['DM0', 'DM12'])).to.have.length(2);
            expect(plan(['DM0', 'DM5'], { maxGap: 0 })).to.have.length(2);
        });

        it('keeps formats separated', () => {
            const blocks = plan(['DM100', 'DM101.S', 'DM102']);
            expect(blocks.map(b => `${b.format}:${b.start}:${b.count}`)).to.deep.equal(['U:100:3', 'S:101:1']);
        });

        it('aligns 32bit elements', () => {
            const blocks = plan(['DM200.L', 'DM202.L', 'DM203.L']);
            expect(blocks.map(b => `${b.start}:${b.count}`)).to.deep.equal(['200:2', '203:1']);
            expect(blocks[0].items[1]).to.deep.equal({ id: 't1', offset: 1 });
        });

        it('splits at the max count per command', () => {
            const words = Array.from({ length: 1001 }, (_, i) => `DM${i}`);
            expect(plan(words).map(b => b.count)).to.deep.equal([1000, 1]);
            const longs = Array.from({ length: 501 }, (_, i) => `DM${i * 2}.L`);
            expect(plan(longs).map(b => b.count)).to.deep.equal([500, 1]);
        });

        it('merges bits across channels', () => {
            const blocks = plan(['MR015', 'MR100', 'MR102']);
            expect(blocks).to.have.length(1);
            expect(blocks[0]).to.include({ device: 'MR', start: '015', count: 4, wire: '' });
            expect(blocks[0].items.map(i => i.offset)).to.deep.equal([0, 1, 3]);
        });
    });

    describe('values', () => {
        it('encodes and decodes float', () => {
            const raw = encodeValue(12.5, 'F');
            expect(raw).to.equal(0x41480000);
            expect(decodeValue(raw, 'F')).to.equal(12.5);
        });

        it('checks the range of the format', () => {
            expect(encodeValue('65535', 'U')).to.equal(65535);
            expect(encodeValue(-32768, 'S')).to.equal(-32768);
            expect(encodeValue(4294967295, 'D')).to.equal(4294967295);
            expect(() => encodeValue(65536, 'U')).to.throw('out of range');
            expect(() => encodeValue(-1, 'U')).to.throw('out of range');
            expect(() => encodeValue(32768, 'S')).to.throw('out of range');
            expect(() => encodeValue('abc', 'U')).to.throw('invalid value');
        });

        it('encodes bits', () => {
            expect([true, 1, '1', 'true', 'TRUE'].map(v => encodeValue(v, 'BIT'))).to.deep.equal([1, 1, 1, 1, 1]);
            expect([false, 0, '0', 'false', ''].map(v => encodeValue(v, 'BIT'))).to.deep.equal([0, 0, 0, 0, 0]);
        });
    });
});
