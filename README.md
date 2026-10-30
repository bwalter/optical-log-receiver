# VNA Log Receiver

A mobile web app that receives VNA log files from a screen via an animated, fountain-coded QR stream — no network connection, pairing or app install required between the devices.

The phone's camera reads the QR stream produced by a [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer) compatible sender (wire format v3), reassembles the payload, decodes the brotli-compressed log, packs it as `vna-<datetime>.log` into `vna-<datetime>.zip` and offers it via the native share sheet (or as a download where file sharing is not supported).

Highlights:

- Fountain coding: frames can be caught in any order; dropped frames cost time, never correctness.
- Multiple QR codes per camera frame and a pool of WebAssembly decode workers ([zxing-wasm](https://github.com/Sec-ant/zxing-wasm)).
- Integrity checks: FNV-1a over the reassembled stream and SHA-256 over the file (when sent in a Decimen container).
- Fully client-side and self-hosted; works offline once loaded.

## Build and run

Requirements: Node.js 22+.

```sh
npm ci
npm run dev       # HTTPS dev server reachable on the LAN (self-signed cert)
npm run build     # production build into dist/
npm run preview   # serve the production build
```

Phones only allow camera access on HTTPS pages. With `npm run dev`, open the printed *Network* URL on the phone and accept the self-signed certificate once.

### Deployment

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds the app on every push and pull request and deploys `dist/` to GitHub Pages on pushes to `main`. Enable it once via **Settings → Pages → Source: GitHub Actions**. The build uses relative paths, so any static HTTPS host works as well.

## Information for senders

### 1. Payload

The transferred file must be ASCII text with three parts separated by a single line feed (`\n`, `0x0A`):

```
vna-brotli-base64-version1\n<datetime>\n<data>
```

| Part | Format | Example |
| --- | --- | --- |
| Magic | Literal `vna-brotli-base64-version1` (lowercase, 26 bytes) | `vna-brotli-base64-version1` |
| Datetime | ISO 8601 `YYYY-MM-DDTHH:MM:SSZ` — UTC, uppercase `T` and `Z`, whole seconds | `2026-10-29T14:54:07Z` |
| Data | `base64(brotli(log text))` — standard alphabet (`A–Z a–z 0–9 + /`), with `=` padding, on a **single line** | `G0gA+J0J8eZ…` |

Rules for the sender:

- **Log text**: UTF-8 encoded before compression. It is stored unchanged as `vna-<datetime>.log` in the zip (line endings are kept as sent).
- **Compression**: brotli (RFC 7932), raw stream as produced by any standard brotli library; quality 11 recommended for the smallest transfer. Not gzip/deflate.
- **Datetime**: the time the log was captured/exported. In file names `:` becomes `-`, e.g. `vna-2026-10-29T14-54-07Z.log` and `vna-2026-10-29T14-54-07Z.zip`.
- **No** BOM, no trailing data after the base64. A trailing newline is tolerated.
- **Size**: the whole transferred file must stay below 64 MB; a few MB of logs typically compress to a few hundred KB.

The receiver is lenient for compatibility (other separators such as space, `|`, `;`, `,`, `_` or none at all; local offsets like `+01:00`; fractional seconds; URL-safe or line-wrapped base64), but senders should produce exactly the format above.

#### Test vector

Log text (2 lines, each ending with `\n`):

```
2026-10-29 14:54:07 INFO sweep start
2026-10-29 14:54:08 INFO sweep done
```

Complete payload (3 lines):

```
vna-brotli-base64-version1
2026-10-29T14:54:07Z
G0gA+J0J8eZkjKQNV58aQs4xTNVQBCf7GZM010ZOT3daAaQMDmzAOaca5rjrSYMSqbyWmyH6IL/yNUjya9sY1hU=
```

Result: `vna-2026-10-29T14-54-07Z.zip` containing `vna-2026-10-29T14-54-07Z.log`. Other brotli implementations or quality levels may produce different data bytes; only the decompressed text has to match.

#### Examples

Python (`pip install brotli`):

```python
import base64
from datetime import datetime, timezone
import brotli

def build_payload(log_text: str, captured: datetime) -> bytes:
    stamp = captured.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = base64.b64encode(brotli.compress(log_text.encode("utf-8"), quality=11)).decode("ascii")
    return f"vna-brotli-base64-version1\n{stamp}\n{data}".encode("ascii")
```

Node.js:

```js
import { brotliCompressSync, constants } from "node:zlib";

function buildPayload(logText, captured = new Date()) {
  const stamp = captured.toISOString().replace(/\.\d{3}Z$/, "Z");
  const data = brotliCompressSync(Buffer.from(logText, "utf8"), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString("base64");
  return Buffer.from(`vna-brotli-base64-version1\n${stamp}\n${data}`, "ascii");
}
```

Shell (`brotli` and GNU coreutils `base64`):

```sh
{
  printf 'vna-brotli-base64-version1\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  brotli -q 11 -c vna.log | base64 -w 0
} > payload.txt
```

### 2. Transport

The payload is sent as an animated QR stream in the Decimen wire format v3. The easiest way is to open the payload file in the Decimen sender ([decimen.app](https://decimen.app/), *send*). Custom senders must match the format exactly:

- **QR codes**: byte mode, error correction level L recommended. Several codes may be shown at once (up to 9 per camera frame are decoded).
- **Frame** = 22-byte header (little-endian) followed by `blockLen` bytes of block data:

  | Offset | Type | Field |
  | --- | --- | --- |
  | 0 | u8 | magic `0xD1` |
  | 1 | u8 | magic `0xC3` |
  | 2 | u8 | version `3` |
  | 3 | u8 | flags — low nibble must be `0` |
  | 4 | u16 | session id (random per sender start) |
  | 6 | u32 | seq |
  | 10 | u16 | k (number of source blocks) |
  | 12 | u16 | blockLen |
  | 14 | u32 | totalLen (bytes of the transferred data) |
  | 18 | u32 | FNV-1a 32-bit of the whole transferred data |

- **Fountain code** (systematic carousel): with `pos = seq % (2k)`, frames with `pos < k` carry block `pos` verbatim; the remaining frames carry the XOR of a pseudorandom subset of 4–24 blocks derived from `(sessionId, seq)` via splitmix32. The last block is zero-padded. See `frameComposition()` in [src/protocol.ts](src/protocol.ts) for the exact algorithm — sender and receiver must derive bit-identical subsets.
- **Container** (optional): the transferred data may either be the raw payload or a Decimen `DCF2` container (as produced by the Decimen sender: file name, media type, optional gzip, SHA-256). See [src/container.ts](src/container.ts).

Changing the session id or any other header field (except `seq`) restarts reception on the receiver.

## License

Copyright (c) 2026 The Optical Log Receiver contributors. Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).

The frame protocol, fountain decoder and container handling are adapted from [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer) (AGPL-3.0-or-later), which makes this repository a derived work under the same license. Bundled third-party components are MIT ([zxing-wasm](https://github.com/Sec-ant/zxing-wasm), [fflate](https://github.com/101arrowz/fflate), [brotli.js](https://github.com/foliojs/brotli.js), [base64-js](https://github.com/beatgammit/base64-js)) and Apache-2.0 ([zxing-cpp](https://github.com/zxing-cpp/zxing-cpp), inside the zxing-wasm WebAssembly module) — both compatible with AGPL-3.0. Full attributions are in [NOTICE](NOTICE).

What this means in practice:

- **Hosting the app** (e.g. on GitHub Pages or an intranet) is conveying it to users over a network: the app links to its source code in the footer, and `LICENSE` and `NOTICE` are shipped in the build output. If you deploy a modified version, point that link to your modified source.
- **Modified versions** must remain under AGPL-3.0-or-later and keep the copyright and license notices.
- **Senders** are separate programs that only exchange data with this app; implementing the wire format and payload format documented above does not by itself put a sender under this license. Copying code from this repository or from Decimen into a sender does.
