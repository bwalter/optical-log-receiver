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

The transferred file content must be ASCII text in this layout:

```
vna-brotli-base64-version1<ISO-8601 date/time><base64(brotli(log text))>
```

| Part | Description |
| --- | --- |
| Magic | Literal `vna-brotli-base64-version1` |
| Date/time | ISO 8601, e.g. `2026-10-29T14:54:07Z`, `2026-10-29T14:54:07.123+01:00`, `2026-10-29T14:54`. Used for the file names. |
| Data | Standard or URL-safe base64 (padding optional, whitespace ignored) of the brotli-compressed log text |

A separator (whitespace/newline, `|`, `;`, `,` or `_`) between the parts is optional but **recommended** (e.g. `\n`), since it removes any ambiguity between the end of the timestamp and the start of the base64 data.

In file names, `:` is replaced by `-` (e.g. `vna-2026-10-29T14-54-07Z.log`).

Example (Python):

```python
import base64, brotli
from datetime import datetime, timezone

payload = (
    "vna-brotli-base64-version1\n"
    + datetime.now(timezone.utc).isoformat(timespec="seconds")
    + "\n"
    + base64.b64encode(brotli.compress(log_text.encode(), quality=11)).decode()
)
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

## License note

The transport is wire-compatible with Decimen Optical Transfer, which is licensed under AGPL-3.0-or-later. The fountain decoder in this repository follows its algorithm; review the licensing implications before distributing.
