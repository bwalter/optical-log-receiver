import { decompress } from "brotli/decompress";
import { zipSync } from "fflate";

export const MAGIC = "vna-brotli-base64-version1";

// ISO 8601 date-time; seconds, fraction and zone optional.
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/;
const ISO_FULL = new RegExp(`${ISO_PREFIX.source}$`);
const SEPARATORS = /^[\s|;,_]*/;

export interface VnaLog {
  prefix: string;
  extension: string;
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
 * Parses `<magic>\n<prefix>\n<extension>\n<ISO datetime>\n<base64(brotli(text))>`.
 */
export function parseVnaPayload(bytes: Uint8Array): VnaLog {
  const s = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  if (!s.startsWith(MAGIC)) throw new Error(`Payload does not start with "${MAGIC}".`);
  const rest = s.slice(MAGIC.length).replace(/^\r?\n/, "");
  const nl1 = rest.indexOf("\n");
  const nl2 = nl1 < 0 ? -1 : rest.indexOf("\n", nl1 + 1);
  if (nl2 < 0) throw new Error("Missing prefix/extension lines.");
  const prefix = safePrefix(rest.slice(0, nl1));
  if (!prefix) throw new Error("Empty or invalid prefix.");
  return {
    prefix,
    extension: safeExtension(rest.slice(nl1 + 1, nl2)),
    ...parseDatedData(rest.slice(nl2 + 1)),
  };
}

/**
 * Parses `<ISO datetime><base64(brotli(text))>`. Optional separators
 * (whitespace, `|`, `;`, `,`, `_`) are tolerated between the parts. Since the
 * datetime has optional trailing parts (e.g. a `Z` that could also start the
 * base64), candidate lengths are tried longest-first until brotli decodes.
 */
function parseDatedData(input: string): { datetime: string; text: Uint8Array } {
  const rest = input.replace(SEPARATORS, "");
  const m = ISO_PREFIX.exec(rest);
  if (!m) throw new Error("Missing ISO date/time.");

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

// Prefix and extension arrive over the optical channel: keep them to harmless file name parts.
function safePrefix(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned;
}

function safeExtension(raw: string): string {
  return raw.trim().replace(/^\.+/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
}

const MIME_TYPES: Record<string, string> = {
  log: "text/plain",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
};

/** `<prefix>-<datetime>.<extension>` and `<prefix>-<datetime>.zip`. */
export function outputNames(log: VnaLog): { fileName: string; zipName: string; mimeType: string } {
  const base = `${log.prefix}-${safeStamp(log.datetime)}`;
  return {
    fileName: log.extension ? `${base}.${log.extension}` : base,
    zipName: `${base}.zip`,
    mimeType: MIME_TYPES[log.extension.toLowerCase()] ?? "application/octet-stream",
  };
}

export function buildFile(log: VnaLog): File {
  const { fileName, mimeType } = outputNames(log);
  return new File([log.text as BlobPart], fileName, { type: mimeType });
}

export function buildZip(log: VnaLog): File {
  const { fileName, zipName } = outputNames(log);
  const parsed = new Date(log.datetime.replace(" ", "T"));
  const mtime = isNaN(parsed.getTime()) ? new Date() : parsed;
  const zipped = zipSync({ [fileName]: [log.text, { level: 6, mtime }] });
  return new File([zipped as BlobPart], zipName, { type: "application/zip" });
}
