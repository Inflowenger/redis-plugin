// The key-level actions: read and write a string, delete, scan the keyspace,
// manage expiry, inspect what a key is, and increment a counter.
//
// Nothing here uses KEYS. A keyspace walk is always SCAN with a cursor, because
// KEYS blocks the whole server for the length of the scan.

import type { Action } from "@inflowenger/node-plugin-sdk";

import type { Client } from "../redis/client.js";
import { asNumber, asString, decodeMode, decodeValue, encodeValue } from "../redis/value.js";
import {
  applyTtl,
  bool,
  boolOr,
  capped,
  int,
  num,
  preview,
  requireList,
  requireStr,
  str,
  strList,
  type Kit,
  type Output,
} from "./kit.js";
import {
  counterIncrementForm,
  keyDeleteForm,
  keyExpireForm,
  keyGetForm,
  keyInspectForm,
  keyScanForm,
  keySetForm,
} from "./forms.js";
import { CLASS, M } from "./methods.js";

// deleteChunk bounds how many keys go into one DEL/UNLINK, so a pattern delete
// of a hundred thousand keys does not build one enormous command.
const deleteChunk = 500;

// The action to point someone at when they read a key of the wrong type.
const readerFor: Record<string, string> = {
  list: "Read list range",
  hash: "Read hash",
  set: "Read set members",
  zset: "Read sorted-set range",
  stream: "Read from stream",
};

// The command that reports the size of each type of value.
const sizeCommand: Record<string, string> = {
  string: "STRLEN",
  list: "LLEN",
  set: "SCARD",
  zset: "ZCARD",
  hash: "HLEN",
  stream: "XLEN",
};

export function keyActions(kit: Kit): Action[] {
  return [
    {
      method: M.keyGet,
      title: "Get value",
      description:
        "Read a string key and commit its value, type and remaining time to live. A key of another type is reported as such, with the action that reads it.",
      icon: { icon: "mdi-key-outline" },
      tags: { class: CLASS.keys },
      form: keyGetForm,
      requestHandler: kit.run("get", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const mode = decodeMode(input.decode);

        await job.progress(50, { title: "get", content: key });

        const [typeReply, ttlReply] = await client.batch([
          ["TYPE", key],
          ["TTL", key],
        ]);
        const type = asString(typeReply);
        const ttl = asNumber(ttlReply);

        if (type === "none") {
          return { key, exists: false, value: null, type: "none", ttl: -2 };
        }
        if (type !== "string") {
          const reader = readerFor[type];
          throw new Error(
            `${key} holds a ${type}, not a string${reader ? ` — read it with the "${reader}" action` : ""}`,
          );
        }

        const value = decodeValue(await client.send("GET", [key]), mode);
        return { key, exists: true, value, type, ttl };
      }),
    },

    {
      method: M.keySet,
      title: "Set value",
      description:
        "Write a string key, optionally with an expiry, a only-if-missing / only-if-present condition, and the previous value returned.",
      icon: { icon: "mdi-content-save-outline" },
      tags: { class: CLASS.keys },
      form: keySetForm,
      requestHandler: kit.run("set", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const value = encodeValue(input.value);
        const ttl = int(input.ttlSeconds, 0, "ttlSeconds");
        const mode = str(input.mode).toUpperCase();
        const keepTtl = bool(input.keepTtl);
        const returnOld = bool(input.returnOld);

        if (ttl > 0 && keepTtl) {
          throw new Error('an expiry and "keep the existing expiry" cannot both be set — Redis rejects SET … EX … KEEPTTL');
        }
        if (mode !== "" && mode !== "NX" && mode !== "XX") {
          throw new Error(`condition must be empty, NX or XX: ${JSON.stringify(mode)}`);
        }

        const args: (string | number)[] = [key, value];
        if (ttl > 0) args.push("EX", ttl);
        if (keepTtl) args.push("KEEPTTL");
        if (mode !== "") args.push(mode);
        if (returnOld) args.push("GET");

        await job.progress(50, { title: "set", content: `${key} = ${preview(value, 60)}` });

        const reply = await client.send("SET", args);

        // With GET the reply is the previous value, so whether the write
        // happened has to be read off the condition instead of off the reply.
        const out: Output = { key };
        if (returnOld) {
          const previous = decodeValue(reply, "auto");
          out.previous = previous;
          out.written = mode === "NX" ? previous === null : mode === "XX" ? previous !== null : true;
        } else {
          out.written = reply !== null;
        }
        out.ttl = asNumber(await client.send("TTL", [key]));
        return out;
      }),
    },

    {
      method: M.keyDelete,
      title: "Delete keys",
      description:
        "Delete keys by name, or every key matching a glob pattern (SCAN-based, confirmed and capped). Missing keys are not an error.",
      icon: { icon: "mdi-delete-outline" },
      tags: { class: CLASS.keys },
      form: keyDeleteForm,
      requestHandler: kit.run("delete", async (job, client, input) => {
        const keys = strList(input.keys);
        const pattern = str(input.pattern);
        const command = boolOr(input.unlink, true) ? "UNLINK" : "DEL";
        const maxKeys = capped(int(input.maxKeys, 1000, "maxKeys"), 100_000);

        if (keys.length === 0 && pattern === "") {
          throw new Error("nothing to delete: name at least one key, or give a pattern");
        }

        const out: Output = { command };
        let deleted = 0;

        if (keys.length > 0) {
          await job.progress(40, { title: "delete", content: `${keys.length} key(s)` });
          deleted += await deleteAll(client, command, keys);
          out.keys = keys;
        }

        if (pattern !== "") {
          if (!bool(input.confirmPattern)) {
            throw new Error(
              `refusing to delete by pattern ${JSON.stringify(pattern)} until the confirmation checkbox is on`,
            );
          }
          if (pattern === "*") {
            throw new Error(
              'refusing the pattern "*": that is every key in the database. Use FLUSHDB through the "Run command" action if that is really the intent',
            );
          }

          await job.progress(60, { title: "scan", content: pattern });
          const page = await client.scan({ match: pattern, max: maxKeys });

          await job.progress(80, { title: "delete", content: `${page.items.length} matched ${pattern}` });
          deleted += await deleteAll(client, command, page.items);

          out.pattern = pattern;
          out.matched = page.items.length;
          out.truncated = !page.done;
          out.cursor = page.cursor;
        }

        out.deleted = deleted;
        return out;
      }),
    },

    {
      method: M.keyScan,
      title: "Scan keys",
      description:
        "Walk the keyspace with SCAN and commit the matching keys, with the cursor to carry on from. Never uses KEYS, so it is safe on a live server.",
      icon: { icon: "mdi-magnify" },
      tags: { class: CLASS.keys },
      form: keyScanForm,
      requestHandler: kit.run("scan", async (job, client, input) => {
        const pattern = str(input.pattern) || "*";
        const type = str(input.type);
        const maxKeys = capped(int(input.maxKeys, 1000, "maxKeys"), 100_000);
        const cursor = str(input.cursor) || "0";

        await job.progress(50, { title: "scan", content: `${pattern}${type !== "" ? ` (${type})` : ""}` });

        const page = await client.scan({ match: pattern, type, max: maxKeys, cursor });
        return {
          pattern,
          type: type !== "" ? type : undefined,
          keys: page.items,
          count: page.items.length,
          cursor: page.cursor,
          done: page.done,
        };
      }),
    },

    {
      method: M.keyExpire,
      title: "Set or clear expiry",
      description:
        "Give a key a time to live (EXPIRE), expire it at a Unix timestamp (EXPIREAT), or make it permanent (PERSIST).",
      icon: { icon: "mdi-timer-sand" },
      tags: { class: CLASS.keys },
      form: keyExpireForm,
      requestHandler: kit.run("expire", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const mode = str(input.mode) || "seconds";
        const condition = str(input.condition).toUpperCase();

        let command: string;
        const args: (string | number)[] = [key];

        if (mode === "persist") {
          command = "PERSIST";
        } else if (mode === "at") {
          const at = int(input.atUnix, 0, "atUnix");
          if (at <= 0) throw new Error("missing required input: atUnix (a Unix timestamp in seconds)");
          command = "EXPIREAT";
          args.push(at);
        } else if (mode === "seconds") {
          const ttl = int(input.ttlSeconds, 0, "ttlSeconds");
          if (ttl <= 0) throw new Error("missing required input: ttlSeconds (above 0)");
          command = "EXPIRE";
          args.push(ttl);
        } else {
          throw new Error(`unknown mode ${JSON.stringify(mode)}: use seconds, at or persist`);
        }

        if (condition !== "" && command !== "PERSIST") {
          if (!["NX", "XX", "GT", "LT"].includes(condition)) {
            throw new Error(`condition must be empty, NX, XX, GT or LT: ${JSON.stringify(condition)}`);
          }
          args.push(condition);
        }

        await job.progress(50, { title: mode, content: key });

        const reply = await client.send(command, args);
        return {
          key,
          command,
          applied: asNumber(reply) === 1,
          ttl: asNumber(await client.send("TTL", [key])),
        };
      }),
    },

    {
      method: M.keyInspect,
      title: "Inspect keys",
      description:
        "For each key: whether it exists, its type, its time to live, its size (length / cardinality) and its memory usage.",
      icon: { icon: "mdi-information-outline" },
      tags: { class: CLASS.keys },
      form: keyInspectForm,
      requestHandler: kit.run("inspect", async (job, client, input) => {
        const keys = requireList(input.keys, "keys");
        const withMemory = boolOr(input.memory, true);

        await job.progress(50, { title: "inspect", content: `${keys.length} key(s)` });

        // One round trip for what every key has, a second for the size, which
        // depends on the type the first one reported.
        const perKey = withMemory ? 3 : 2;
        const first = await client.batch(
          keys.flatMap((key) => {
            const cmds: [string, ...(string | number)[]][] = [
              ["TYPE", key],
              ["TTL", key],
            ];
            if (withMemory) cmds.push(["MEMORY", "USAGE", key]);
            return cmds;
          }),
          true,
        );

        const types = keys.map((_, i) => asString(first[i * perKey]));
        const sizeCmds = keys
          .map((key, i) => {
            const command = sizeCommand[types[i]];
            return command ? ([command, key] as [string, string]) : null;
          })
          .filter((cmd): cmd is [string, string] => cmd !== null);
        const sizes = await client.batch(sizeCmds, true);

        let sizeAt = 0;
        const report = keys.map((key, i) => {
          const type = types[i];
          const ttlReply = first[i * perKey + 1];
          const memoryReply = withMemory ? first[i * perKey + 2] : null;
          const entry: Output = {
            key,
            exists: type !== "none",
            type,
            ttl: ttlReply instanceof Error ? null : asNumber(ttlReply),
          };
          if (sizeCommand[type]) {
            const size = sizes[sizeAt++];
            entry.size = size instanceof Error ? null : asNumber(size);
          }
          if (withMemory) {
            entry.memoryBytes = memoryReply instanceof Error || memoryReply === null ? null : asNumber(memoryReply);
          }
          return entry;
        });

        return {
          keys: report,
          count: report.length,
          missing: report.filter((entry) => entry.exists === false).map((entry) => entry.key),
        };
      }),
    },

    {
      method: M.counterIncrement,
      title: "Increment counter",
      description:
        "Add to a counter atomically, on a key (INCRBY) or on one field of a hash (HINCRBY). A fractional step uses the float form. An expiry can be set on first use only, which is what a rate-limit window needs.",
      icon: { icon: "mdi-counter" },
      tags: { class: CLASS.keys },
      form: counterIncrementForm,
      requestHandler: kit.run("increment", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const field = str(input.field);
        const by = num(input.by, 1, "by");
        const ttl = int(input.ttlSeconds, 0, "ttlSeconds");
        const float = !Number.isInteger(by);

        const command = field !== "" ? (float ? "HINCRBYFLOAT" : "HINCRBY") : float ? "INCRBYFLOAT" : "INCRBY";
        const args = field !== "" ? [key, field, by] : [key, by];

        await job.progress(50, { title: "increment", content: `${key}${field !== "" ? `.${field}` : ""} by ${by}` });

        const reply = await client.send(command, args);
        const value = Number(asString(reply));

        const out: Output = { key, command, value };
        if (field !== "") out.field = field;

        if (ttl > 0) {
          // Only when the key has no expiry yet: a counter whose window is
          // extended on every hit never resets, which is the classic rate-limit
          // bug.
          const current = asNumber(await client.send("TTL", [key]));
          if (current === -1) {
            await client.send("EXPIRE", [key, ttl]);
            out.expirySet = true;
          } else {
            out.expirySet = false;
          }
        }
        out.ttl = asNumber(await client.send("TTL", [key]));
        return out;
      }),
    },
  ];
}

// deleteAll removes keys in chunks and totals what the server reported.
async function deleteAll(client: Client, command: string, keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += deleteChunk) {
    const chunk = keys.slice(i, i + deleteChunk);
    deleted += asNumber(await client.send(command, chunk));
  }
  return deleted;
}
