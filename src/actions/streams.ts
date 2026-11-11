// The stream actions and pub/sub. A stream is the durable one — entries stay
// until they are trimmed, and a consumer group lets several readers share the
// work — while PUBLISH is fire-and-forget: a message with no subscriber is gone.

import type { Action } from "@inflowenger/node-plugin-sdk";

import type { Arg, Client } from "../redis/client.js";
import { asNumber, asString, decodeMode, encodeValue, jsonObjectInput, pairsToObject, type DecodeMode } from "../redis/value.js";
import { applyTtl, bool, boolOr, capped, int, preview, requireStr, str, type Kit, type Output } from "./kit.js";
import { publishForm, streamAddForm, streamReadForm } from "./forms.js";
import { CLASS, M } from "./methods.js";

// The socket backstop beyond the wait the server was asked for.
const blockGraceMs = 5_000;

/** One stream entry as the node commits it. */
interface Entry {
  id: string;
  fields: Record<string, unknown>;
}

export function streamActions(kit: Kit): Action[] {
  return [
    {
      method: M.streamAdd,
      title: "Append to stream",
      description:
        "Append an entry to a stream (XADD), optionally trimming it to a maximum length. The server assigns the entry id unless you give one.",
      icon: { icon: "mdi-text-box-plus-outline" },
      tags: { class: CLASS.stream },
      form: streamAddForm,
      requestHandler: kit.run("stream add", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const fields = jsonObjectInput(input.fields, "fields");
        const entries = Object.entries(fields);
        const id = str(input.id) || "*";
        const maxLength = int(input.maxLength, 0, "maxLength");
        const ttl = int(input.ttlSeconds, 0, "ttlSeconds");

        if (entries.length === 0) throw new Error("fields is empty — a stream entry needs at least one field");

        const args: Arg[] = [key];
        // The approximate form is the cheap one: it trims whole nodes of the
        // underlying radix tree rather than exactly to the limit.
        if (maxLength > 0) args.push("MAXLEN", "~", maxLength);
        args.push(id);
        for (const [field, value] of entries) args.push(field, encodeValue(value));

        await job.progress(50, { title: "stream add", content: `${key} ← ${preview(entries.map(([f]) => f).join(" "), 60)}` });

        const assigned = asString(await client.send("XADD", args));
        return {
          key,
          id: assigned,
          fields,
          length: asNumber(await client.send("XLEN", [key])),
          ttl: await applyTtl(client, key, ttl),
        };
      }),
    },

    {
      method: M.streamRead,
      title: "Read from stream",
      description:
        "Read stream entries three ways: a historical range (XRANGE / XREVRANGE), only what is new since an id (XREAD, optionally waiting), or the next unread batch for a consumer group (XREADGROUP, with the group created on first use).",
      icon: { icon: "mdi-text-box-search-outline" },
      tags: { class: CLASS.stream },
      form: streamReadForm,
      requestHandler: kit.run("stream read", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const mode = str(input.mode) || "range";
        const count = capped(int(input.count, 10, "count"), 10_000);
        const blockSeconds = int(input.blockSeconds, 0, "blockSeconds");
        const decode = decodeMode(input.decode);

        const out: Output = { key, mode };
        let entries: Entry[] = [];

        if (mode === "range") {
          const start = str(input.start) || "-";
          const end = str(input.end) || "+";
          const reverse = bool(input.reverse);
          const command = reverse ? "XREVRANGE" : "XRANGE";
          // XREVRANGE takes its bounds the other way round.
          const bounds = reverse ? [end, start] : [start, end];

          await job.progress(50, { title: "stream range", content: `${key} ${bounds[0]}..${bounds[1]}` });

          const reply = await client.send(command, [key, ...bounds, "COUNT", count]);
          entries = rangeEntries(reply, decode);
          out.command = command;
        } else if (mode === "new") {
          const lastId = str(input.lastId) || "$";
          const args: Arg[] = ["COUNT", count];
          if (blockSeconds > 0) args.push("BLOCK", blockSeconds * 1000);
          args.push("STREAMS", key, lastId);

          await job.progress(50, {
            title: "stream read",
            content: `${key} after ${lastId}${blockSeconds > 0 ? ` (waiting up to ${blockSeconds}s)` : ""}`,
          });

          const reply = await readMaybeBlocking(client, "XREAD", args, blockSeconds);
          entries = streamsEntries(reply, decode);
          out.command = "XREAD";
          out.after = lastId;
          out.waited = blockSeconds > 0;
        } else if (mode === "group") {
          const group = requireStr(input.group, "group");
          const consumer = str(input.consumer) || "inflow";

          if (boolOr(input.createGroup, true)) {
            await ensureGroup(client, key, group);
          }

          const args: Arg[] = ["GROUP", group, consumer, "COUNT", count];
          if (blockSeconds > 0) args.push("BLOCK", blockSeconds * 1000);
          // ">" means "entries never delivered to this group".
          args.push("STREAMS", key, ">");

          await job.progress(50, {
            title: "stream group read",
            content: `${key} as ${group}/${consumer}${blockSeconds > 0 ? ` (waiting up to ${blockSeconds}s)` : ""}`,
          });

          const reply = await readMaybeBlocking(client, "XREADGROUP", args, blockSeconds);
          entries = streamsEntries(reply, decode);
          out.command = "XREADGROUP";
          out.group = group;
          out.consumer = consumer;
          out.waited = blockSeconds > 0;

          if (bool(input.ack) && entries.length > 0) {
            out.acked = asNumber(await client.send("XACK", [key, group, ...entries.map((entry) => entry.id)]));
          } else {
            out.acked = 0;
            out.pending = entries.length;
          }
        } else {
          throw new Error(`unknown mode ${JSON.stringify(mode)}: use range, new or group`);
        }

        out.entries = entries;
        out.count = entries.length;
        out.empty = entries.length === 0;
        // The id to carry into the next run of a "new entries" reader.
        out.lastId = entries.length > 0 ? entries[entries.length - 1].id : str(input.lastId) || "";
        out.length = asNumber(await client.send("XLEN", [key]));
        return out;
      }),
    },

    {
      method: M.publish,
      title: "Publish message",
      description:
        "Publish a message to a channel (PUBLISH) and report how many subscribers received it. Pub/sub keeps nothing: a message published with no subscriber is dropped — use a stream when it has to survive.",
      icon: { icon: "mdi-broadcast" },
      tags: { class: CLASS.pubsub },
      form: publishForm,
      requestHandler: kit.run("publish", async (job, client, input) => {
        const channel = requireStr(input.channel, "channel");
        const message = encodeValue(input.message);
        if (message === "") throw new Error("missing required input: message");

        await job.progress(50, { title: "publish", content: `${channel} ← ${preview(message, 60)}` });

        const receivers = asNumber(await client.send("PUBLISH", [channel, message]));
        return { channel, receivers, delivered: receivers > 0, bytes: Buffer.byteLength(message) };
      }),
    },
  ];
}

// readMaybeBlocking sends a read on its own socket when it was asked to wait,
// and on the pooled one when it was not.
async function readMaybeBlocking(
  client: Client,
  command: string,
  args: Arg[],
  blockSeconds: number,
): Promise<unknown> {
  if (blockSeconds > 0) {
    return client.sendBlocking(command, args, blockSeconds * 1000 + blockGraceMs);
  }
  return client.send(command, args);
}

// ensureGroup creates a consumer group if it is missing, creating the stream
// too, so a flow works on its first run. An existing group is not an error —
// Redis says BUSYGROUP and that is the normal case from the second run on.
async function ensureGroup(client: Client, key: string, group: string): Promise<void> {
  try {
    // "$" starts the group at the end of the stream: a new group reads what
    // arrives from now on, not the whole backlog.
    await client.send("XGROUP", ["CREATE", key, group, "$", "MKSTREAM"]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/BUSYGROUP/i.test(message)) throw e;
  }
}

/** rangeEntries parses an XRANGE / XREVRANGE reply: [[id, [f, v, …]], …]. */
export function rangeEntries(reply: unknown, decode: DecodeMode): Entry[] {
  if (!Array.isArray(reply)) return [];
  const out: Entry[] = [];
  for (const item of reply) {
    if (!Array.isArray(item) || item.length < 2) continue;
    out.push({ id: asString(item[0]), fields: pairsToObject(item[1], decode) });
  }
  return out;
}

/**
 * streamsEntries parses an XREAD / XREADGROUP reply: [[stream, [[id, [f, v, …]],
 * …]], …]. The plugin reads one stream per call, so every stream's entries are
 * concatenated in order.
 */
export function streamsEntries(reply: unknown, decode: DecodeMode): Entry[] {
  if (!Array.isArray(reply)) return [];
  const out: Entry[] = [];
  for (const stream of reply) {
    if (!Array.isArray(stream) || stream.length < 2) continue;
    out.push(...rangeEntries(stream[1], decode));
  }
  return out;
}
