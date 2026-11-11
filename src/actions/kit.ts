// What every action group shares: the shape of a handler, the job runner that
// wraps one, and the input readers that turn a form field into a command
// argument. Keeping these in one place is what lets each action file be only its
// own Redis logic.

import type { Job } from "@inflowenger/node-plugin-sdk";

import type { Client } from "../redis/client.js";
import type { VarResolver } from "./vars.js";

/** One action's output: what the node commits for downstream nodes to read. */
export type Output = Record<string, unknown>;

/**
 * A handler is the pure work of one action over a ready client. Finishing the
 * job is left to the runner; throwing fails the node with the error's message.
 */
export type Handler = (
  job: Job,
  client: Client,
  input: Record<string, unknown>,
  resolver: VarResolver,
) => Promise<Output>;

/**
 * Kit is what an action group is handed: the runner that adapts a handler into
 * an SDK job handler. The groups never touch the connection pool themselves.
 */
export interface Kit {
  run(title: string, handler: Handler): (job: Job) => Promise<void>;
}

// --------------------------------------------------------------- inputs --

/** str reads a trimmed string field. */
export function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** raw reads a string field without trimming — a value's own whitespace counts. */
export function raw(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * strList reads a list field. The form renders an array of strings, but a
 * {{$.path}} token can also resolve to one string holding a JSON array or a
 * comma/newline-separated list, so all three are accepted. Blank entries are
 * dropped.
 */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item.trim() : str(item))).filter((item) => item !== "");
  }
  const text = str(value);
  if (text === "") return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return strList(parsed);
    } catch {
      // not JSON after all — fall through to the separated form
    }
  }
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** bool reads a checkbox, tolerating the string form a token can resolve to. */
export function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const text = str(value).toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "on";
}

/**
 * boolOr reads a checkbox whose form default is `fallback`. A field the host
 * never sent — an older saved node, or a call built by hand — must behave as the
 * form says it would, so an absent value is the default rather than false.
 */
export function boolOr(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined || value === "") return fallback;
  return bool(value);
}

/**
 * int reads a whole-number field. An empty field means `fallback`; anything that
 * is not a whole number is an error, since it is almost always an unresolved
 * {{$.path}} token rather than a typo.
 */
export function int(value: unknown, fallback: number, field: string): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(str(value));
  if (!Number.isInteger(n)) {
    throw new Error(`${field} must be a whole number: ${JSON.stringify(str(value))}`);
  }
  return n;
}

/** num reads a decimal field, with the same treatment as int. */
export function num(value: unknown, fallback: number, field: string): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(str(value));
  if (!Number.isFinite(n)) {
    throw new Error(`${field} must be a number: ${JSON.stringify(str(value))}`);
  }
  return n;
}

/** capped clamps a count to a ceiling, treating 0 and below as the ceiling. */
export function capped(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > ceiling) return ceiling;
  return Math.floor(value);
}

/** requireStr reads a field the action cannot run without. */
export function requireStr(value: unknown, field: string): string {
  const text = str(value);
  if (text === "") throw new Error(`missing required input: ${field}`);
  return text;
}

/** requireList reads a list field the action cannot run without. */
export function requireList(value: unknown, field: string): string[] {
  const items = strList(value);
  if (items.length === 0) throw new Error(`missing required input: ${field} (at least one entry)`);
  return items;
}

// --------------------------------------------------------------- common --

/**
 * applyTtl sets an expiry on a key a write has just created or extended, which
 * is the one thing nearly every write action offers. 0 (the default) leaves the
 * key's own expiry alone. Returns the TTL in seconds as Redis reports it
 * afterwards: -1 for no expiry, -2 for a key that is not there.
 */
export async function applyTtl(client: Client, key: string, ttlSeconds: number): Promise<number> {
  if (ttlSeconds > 0) {
    await client.send("EXPIRE", [key, ttlSeconds]);
  }
  return Number(await client.send("TTL", [key]));
}

/** errText renders an error for the node, with Redis's own message kept intact. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** preview trims a value to one short line for a progress frame. */
export function preview(text: string, width = 90): string {
  const one = text.split(/\s+/).filter(Boolean).join(" ");
  return one.length > width ? one.slice(0, width - 1) + "…" : one;
}
