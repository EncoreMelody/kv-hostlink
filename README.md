# @littlescrew/kv-hostlink

KEYENCE KV PLC **Host Link** (upper link) client for Node.js over TCP. No dependencies.

- One TCP connection, commands queued and sent one at a time (the PLC accepts one command at a time)
- `RDS` / `WR` / `WRS` / `?M` / `?K`, error responses `E0`..`E6` mapped to `HostLinkError`
- Address parser with all KV formats (`.U .S .H .D .L`) plus `.F` float, and a read planner that merges close addresses into few `RDS` commands

Used by the [FUXA](https://github.com/frangoteam/FUXA) `KeyenceHostLink` device driver.

## Install

```sh
npm install @littlescrew/kv-hostlink
```

## Usage

```js
const { HostLinkClient, parseAddress, buildReadPlan, decodeValue } = require('@littlescrew/kv-hostlink');

const client = new HostLinkClient({ host: '192.168.2.10', port: 8501, timeout: 2500 });
client.on('error', console.error);
await client.connect();

await client.getModel();                       // { code: '132', name: 'KV-N60' }
await client.getMode();                        // { code: 1, name: 'RUN' }
await client.readWords('DM', 100, 5, 'U');     // RDS DM100.U 5 -> [4662, 127, 0, 0, 0]
await client.writeWords('DM', 30000, [1, 2], 'U');   // WRS DM30000.U 2 1 2

// read many tags with merged commands
const tags = ['DM100', 'DM101', 'DM105.S', 'DM200.F', 'MR1000'];
const plan = buildReadPlan(tags.map(t => ({ id: t, addr: parseAddress(t) })));
for (const block of plan) {
    const values = await client.readWords(block.device, block.start, block.count, block.wire);
    block.items.forEach(item => console.log(item.id, decodeValue(values[item.offset], block.format)));
}
client.close();
```

## Address format

`<device><number>[.<format>]`, e.g. `DM100`, `DM100.S`, `DM200.L`, `DM300.F`, `MR1000`, `R500`, `TC0`, `W1F.H`

| Format | Meaning | Words | Max per RDS |
|---|---|---|---|
| `.U` | 16 bit unsigned (default for word devices) | 1 | 1000 |
| `.S` | 16 bit signed | 1 | 1000 |
| `.H` | 16 bit hex | 1 | 1000 |
| `.D` | 32 bit unsigned (default for TC/TS/CC/CS) | 2 | 500 |
| `.L` | 32 bit signed | 2 | 500 |
| `.F` | 32 bit float, read/written as `.D` (IEEE 754, low word first) | 2 | 500 |
| (none) | bit 0/1 (default for bit devices) | - | 1000 |

| Devices | Numbering |
|---|---|
| `DM EM FM ZF TM CM VM Z` | decimal word |
| `W` | hexadecimal word |
| `TC TS CC CS` | timer/counter current and set value, one 32 bit value per number |
| `R MR LR CR` | channel + 2 digit bit (`MR1015` = channel 10 bit 15) |
| `B VB` | hexadecimal bit |
| `T C` | timer/counter contact, bit only |

Not every device exists on every model (e.g. KV Nano answers `E1` to `EM/FM/ZF`).

## Errors (manual p.8-36)

| Code | Meaning |
|---|---|
| E0 | Device number error |
| E1 | Command error |
| E2 | Program not registered |
| E4 | Write protected |
| E5 | Unit error |
| E6 | No comment |

A request without answer within `timeout` rejects with `HostLinkTimeoutError` and closes the connection, so a late answer cannot be matched to the next command.

## Tested with

KV-N60AT + KV-NC1EP, port 8501: read/write of `.U .S .H .D .L .F` and bits verified, values cross-checked with MC protocol and EtherNet/IP CIP.

## 繁體中文說明

KEYENCE KV 系列 PLC 的上位鏈路（Host Link）TCP 用戶端，不依賴任何套件。PLC 端只要乙太網單元開啟 Host Link 埠（預設 8501），不需要額外的 MC 協定設定。已在 KV-N60AT + KV-NC1EP 實機驗證所有資料格式的讀寫。

## License

MIT
