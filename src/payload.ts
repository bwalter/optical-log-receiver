import { decompress } from "brotli/decompress";
import { zipSync } from "fflate";

export const MAGIC = "vna-brotli-base64-version1";

// ISO 8601 date-time; seconds, fraction and zone optional.
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/;
const ISO_FULL = new RegExp(`${ISO_PREFIX.source}$`);
const SEPARATORS = /^[\s|;,_]*/;

export interface VnaLog {
  datetime: string;
  text: Uint8Array;
}

function base64ToBytes(b64: string): Uint8Array {
  let s = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("Invalid base64.");
  s = s.replace(/=+$/, "");
  if (s.length % 4 === 1) throw new Error("Invalid base64 length.");
  const bin = atob(s + "===".slice(0, (4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Parses `<magic><ISO datetime><base64(brotli(text))>`. Optional separators
 * (whitespace, `|`, `;`, `,`, `_`) are tolerated between the parts. Since the
 * datetime has optional trailing parts (e.g. a `Z` that could also start the
 * base64), candidate lengths are tried longest-first until brotli decodes.
 */
export function parseVnaPayload(bytes: Uint8Array): VnaLog {
  const s = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  if (!s.startsWith(MAGIC)) throw new Error(`Payload does not start with "${MAGIC}".`);
  const rest = s.slice(MAGIC.length).replace(SEPARATORS, "");
  const m = ISO_PREFIX.exec(rest);
  if (!m) throw new Error("Missing ISO date/time after magic.");

  let lastError: unknown;
  for (let len = m[0].length; len >= 16; len--) {
    const datetime = rest.slice(0, len);
    if (!ISO_FULL.test(datetime)) continue;
    try {
      const compressed = base64ToBytes(rest.slice(len).replace(SEPARATORS, ""));
      const text = decompress(compressed);
      if (!text) throw new Error("Brotli decompression failed.");
      return { datetime, text };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not decode payload.");
}

/** Filesystem-safe variant of the ISO timestamp (`:` is not allowed on many platforms). */
export function safeStamp(datetime: string): string {
  return datetime.replace(/:/g, "-").replace(/[^0-9A-Za-z.+\-T]/g, "_");
}

export function buildZip(log: VnaLog): File {
  const stamp = safeStamp(log.datetime);
  const parsed = new Date(log.datetime.replace(" ", "T"));
  const mtime = isNaN(parsed.getTime()) ? new Date() : parsed;
  const zipped = zipSync({ [`vna-${stamp}.log`]: [log.text, { level: 6, mtime }] });
  return new File([zipped as BlobPart], `vna-${stamp}.zip`, { type: "application/zip" });
}
