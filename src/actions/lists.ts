// The list actions: push, pop and read a range. Together they are a queue — a
// push on one node and a (optionally waiting) pop on another is the standard way
// to hand work between two flows.

import type { Action } from "@inflowenger/node-plugin-sdk";

import { asNumber, decodeMode, decodeValue, encodeValue } from "../redis/value.js";
import { applyTtl, bool, int, requireList, requireStr, str, type Kit, type Output } from "./kit.js";
import { listPopForm, listPushForm, listRangeForm } from "./forms.js";
import { CLASS, M } from "./methods.js";

// How much longer than the Redis-side wait the socket is given before it is
// dropped. The server answers on its own timeout; this is only the backstop.
const blockGraceMs = 5_000;

export function listActions(kit: Kit): Action[] {
  return [
    {
      method: M.listPush,
      title: "Push to list",
      description:
        "Append items to a list (RPUSH / LPUSH), optionally capping its length with LTRIM so a log or recent-items list cannot grow without bound.",
      icon: { icon: "mdi-playlist-plus" },
      tags: { class: CLASS.list },
      form: listPushForm,
      requestHandler: kit.run("push", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const values = requireList(input.values, "values").map((value) => encodeValue(value));
        const side = str(input.side) === "left" ? "left" : "right";
        const maxLength = int(input.maxLength, 0, "maxLength");
        const onlyIfExists = bool(input.onlyIfExists);
        const ttl = int(input.ttlSeconds, 0, "ttlSeconds");

        const command = side === "left" ? (onlyIfExists ? "LPUSHX" : "LPUSH") : onlyIfExists ? "RPUSHX" : "RPUSH";

        await job.progress(50, { title: "push", content: `${values.length} → ${key} (${side})` });

        let length = asNumber(await client.send(command, [key, ...values]));

        const out: Output = { key, command, pushed: length === 0 && onlyIfExists ? 0 : values.length, trimmed: false };
        if (length === 0 && onlyIfExists) {
          // X variants do nothing when the list is missing, and say so with 0.
          out.created = false;
        }

        if (maxLength > 0 && length > maxLength) {
          // Keep the items nearest the end that was just pushed to: that is the
          // newest end, whichever side it was.
          const range: [number, number] = side === "left" ? [0, maxLength - 1] : [-maxLength, -1];
          await client.send("LTRIM", [key, ...range]);
          length = asNumber(await client.send("LLEN", [key]));
          out.trimmed = true;
        }

        out.length = length;
        out.ttl = await applyTtl(client, key, ttl);
        return out;
      }),
    },

    {
      method: M.listPop,
      title: "Pop from list",
      description:
        "Take items off a list (LPOP / RPOP), or wait for one to arrive (BLPOP / BRPOP) on a connection of its own. An empty list is a successful run with no values, not an error.",
      icon: { icon: "mdi-playlist-minus" },
      tags: { class: CLASS.list },
      form: listPopForm,
      requestHandler: kit.run("pop", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const side = str(input.side) === "right" ? "right" : "left";
        const count = int(input.count, 1, "count");
        const blockSeconds = int(input.blockSeconds, 0, "blockSeconds");
        const mode = decodeMode(input.decode);

        if (count < 1) throw new Error("count must be 1 or more");

        const out: Output = { key };
        let values: unknown[] = [];

        if (blockSeconds > 0) {
          const command = side === "left" ? "BLPOP" : "BRPOP";
          await job.progress(50, { title: "waiting", content: `${command} ${key} up to ${blockSeconds}s` });

          // BLPOP answers [key, value], or nil when its own timeout expires.
          const reply = (await client.sendBlocking(
            command,
            [key, blockSeconds],
            blockSeconds * 1000 + blockGraceMs,
          )) as unknown[] | null;
          out.command = command;
          out.waited = true;
          if (reply && reply.length >= 2) values = [decodeValue(reply[1], mode)];
        } else {
          const command = side === "left" ? "LPOP" : "RPOP";
          await job.progress(50, { title: "pop", content: `${command} ${key}` });

          const reply = await client.send(command, count > 1 ? [key, count] : [key]);
          out.command = command;
          if (Array.isArray(reply)) {
            values = reply.map((item) => decodeValue(item, mode));
          } else if (reply !== null && reply !== undefined) {
            values = [decodeValue(reply, mode)];
          }
        }

        out.values = values;
        out.count = values.length;
        out.empty = values.length === 0;
        out.length = asNumber(await client.send("LLEN", [key]));
        return out;
      }),
    },

    {
      method: M.listRange,
      title: "Read list range",
      description: "Read a slice of a list (LRANGE) without removing anything, with the list's total length.",
      icon: { icon: "mdi-format-list-numbered" },
      tags: { class: CLASS.list },
      form: listRangeForm,
      requestHandler: kit.run("read list", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const start = int(input.start, 0, "start");
        const stop = int(input.stop, -1, "stop");
        const mode = decodeMode(input.decode);

        await job.progress(50, { title: "read list", content: `${key}[${start}..${stop}]` });

        const [rangeReply, lengthReply] = await client.batch([
          ["LRANGE", key, start, stop],
          ["LLEN", key],
        ]);

        const values = Array.isArray(rangeReply) ? rangeReply.map((item) => decodeValue(item, mode)) : [];
        return { key, values, count: values.length, length: asNumber(lengthReply) };
      }),
    },
  ];
}
