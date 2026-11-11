// Redis stores bytes; a flow wants values. This module is the whole of the
// plugin's opinion about the conversion, in both directions, so every action
// reads and writes a value the same way.
//
//   writing  — a string goes as typed; a number, a boolean, an object or an
//              array is rendered (objects as JSON), so a flow can hand a record
//              straight to a SET or an XADD.
//   reading  — "auto" (the default) parses a value that is plainly a JSON object
//              or array and leaves everything else as text, so "007" stays
//              "007"; "json" insists on JSON; "text" never parses.

/** How a value read back from Redis is decoded. */
export type DecodeMode = "auto" | "text" | "json";

/** decodeMode reads the form's decode field, defaulting to "auto". */
export function decodeMode(raw: unknown): DecodeMode {
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return mode === "text" || mode === "json" ? mode : "auto";
}

/**
 * encodeValue renders a value for the wire. Objects and arrays become JSON,
 * which is what makes "write the upstream node's record into this key" work
 * without a transform node in between.
 */
export function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return JSON.stringify(value);
}

/**
 * decodeValue turns one reply value into what the node commits. A Buffer becomes
 * text (base64 when it is not valid UTF-8, so binary values survive the trip);
 * a string is parsed according to the mode.
 */
export function decodeValue(raw: unknown, mode: DecodeMode = "auto"): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Buffer.isBuffer(raw)) return decodeValue(bufferToText(raw), mode);
  if (Array.isArray(raw)) return raw.map((item) => decodeValue(item, mode));
  if (typeof raw !== "string") return raw;

  if (mode === "text") return raw;
  if (mode === "json") {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `value is not JSON (decoding is set to "json"): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // auto: only a plain JSON object or array is parsed. Numbers, booleans and
  // bare words are left as text, because a zero-padded code or an id that
  // happens to be digits must not silently change shape.
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** bufferToText renders bytes as UTF-8 text, or base64 when they are not text. */
export function bufferToText(buf: Buffer): string {
  const text = buf.toString("utf8");
  return Buffer.compare(Buffer.from(text, "utf8"), buf) === 0 ? text : buf.toString("base64");
}

/**
 * pairsToObject turns a flat [field, value, field, value, …] reply — HGETALL, an
 * XADD entry's fields, CONFIG GET — into an object, decoding each value.
 */
export function pairsToObject(flat: unknown, mode: DecodeMode = "auto"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[String(decodeValue(flat[i], "text"))] = decodeValue(flat[i + 1], mode);
  }
  return out;
}

/** asString renders a reply item as text, without any JSON parsing. */
export function asString(raw: unknown): string {
  const value = decodeValue(raw, "text");
  return value === null ? "" : String(value);
}

/** asNumber renders a reply item as a number, with 0 for a nil reply. */
export function asNumber(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number(asString(raw));
  return Number.isFinite(n) ? n : 0;
}

/**
 * jsonObjectInput reads a form field that must hold a JSON object — a hash's
 * fields, a stream entry, a sorted set's member → score map. The error names the
 * field, since that is what the person has to go and fix.
 */
export function jsonObjectInput(raw: unknown, field: string): Record<string, unknown> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") throw new Error(`missing required input: ${field} (a JSON object)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${field} must be a JSON object: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object of name → value, not ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * splitCommandLine splits a command line the way a shell or redis-cli would:
 * on whitespace, honouring single and double quotes, so a value with spaces can
 * be typed in one box. A backslash escapes the next character inside double
 * quotes.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | "" = "";
  let started = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "") {
      if (/\s/.test(ch)) {
        if (started) {
          out.push(current);
          current = "";
          started = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        started = true;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }

    if (ch === "\\" && quote === '"' && i + 1 < line.length) {
      current += line[++i];
      continue;
    }
    if (ch === quote) {
      quote = "";
      continue;
    }
    current += ch;
  }

  if (quote !== "") throw new Error(`unbalanced ${quote} quote in the command`);
  if (started) out.push(current);
  return out;
}
