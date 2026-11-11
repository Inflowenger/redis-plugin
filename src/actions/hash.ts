// The hash actions: read a hash as an object, and write (or prune) its fields
// from a JSON object. A hash is how a flow keeps a record in Redis, so these two
// are the actions a workflow reaches for most after get/set.

import type { Action } from "@inflowenger/node-plugin-sdk";

import { asNumber, decodeMode, decodeValue, encodeValue, jsonObjectInput, pairsToObject } from "../redis/value.js";
import { applyTtl, bool, int, requireStr, str, strList, type Kit, type Output } from "./kit.js";
import { hashGetForm, hashSetForm } from "./forms.js";
import { CLASS, M } from "./methods.js";

export function hashActions(kit: Kit): Action[] {
  return [
    {
      method: M.hashGet,
      title: "Read hash",
      description:
        "Read a hash as an object — every field (HGETALL) or only the ones you name (HMGET) — with the key's time to live.",
      icon: { icon: "mdi-table-eye" },
      tags: { class: CLASS.hash },
      form: hashGetForm,
      requestHandler: kit.run("read hash", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const fields = strList(input.fields);
        const mode = decodeMode(input.decode);

        await job.progress(50, { title: "read hash", content: key });

        const [existsReply, ttlReply] = await client.batch([
          ["EXISTS", key],
          ["TTL", key],
        ]);

        const out: Output = {
          key,
          exists: asNumber(existsReply) === 1,
          ttl: asNumber(ttlReply),
        };

        if (fields.length > 0) {
          const reply = (await client.send("HMGET", [key, ...fields])) as unknown[];
          const values: Record<string, unknown> = {};
          const missing: string[] = [];
          fields.forEach((field, i) => {
            const value = reply?.[i] ?? null;
            values[field] = value === null ? null : decodeValue(value, mode);
            if (value === null) missing.push(field);
          });
          out.fields = values;
          out.count = fields.length - missing.length;
          out.missingFields = missing;
        } else {
          const values = pairsToObject(await client.send("HGETALL", [key]), mode);
          out.fields = values;
          out.count = Object.keys(values).length;
        }

        return out;
      }),
    },

    {
      method: M.hashSet,
      title: "Write hash fields",
      description:
        "Write fields into a hash from a JSON object, optionally only the ones that do not exist yet, and remove other fields in the same call.",
      icon: { icon: "mdi-table-edit" },
      tags: { class: CLASS.hash },
      form: hashSetForm,
      requestHandler: kit.run("write hash", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const removeFields = strList(input.removeFields);
        const onlyIfMissing = bool(input.onlyIfMissing);
        const ttl = int(input.ttlSeconds, 0, "ttlSeconds");

        // The fields object is optional when the call is only pruning.
        const hasFields = str(input.fields) !== "";
        const fields = hasFields ? jsonObjectInput(input.fields, "fields") : {};
        const entries = Object.entries(fields);

        if (entries.length === 0 && removeFields.length === 0) {
          throw new Error("nothing to write: give a JSON object of fields, or fields to remove");
        }

        await job.progress(50, { title: "write hash", content: `${key} — ${entries.length} field(s)` });

        const out: Output = { key, fieldsWritten: 0, fieldsRemoved: 0 };

        if (entries.length > 0) {
          if (onlyIfMissing) {
            // HSETNX is per field, so one pipeline reports which fields were
            // new and which were left alone.
            const replies = await client.batch(
              entries.map(([field, value]) => ["HSETNX", key, field, encodeValue(value)] as [string, ...string[]]),
            );
            const written: string[] = [];
            const skipped: string[] = [];
            entries.forEach(([field], i) => (asNumber(replies[i]) === 1 ? written : skipped).push(field));
            out.fieldsWritten = written.length;
            out.fields = written;
            out.skipped = skipped;
            out.created = written.length;
          } else {
            const args: string[] = [key];
            for (const [field, value] of entries) args.push(field, encodeValue(value));
            const created = asNumber(await client.send("HSET", args));
            out.fieldsWritten = entries.length;
            out.fields = entries.map(([field]) => field);
            out.created = created;
          }
        }

        if (removeFields.length > 0) {
          out.fieldsRemoved = asNumber(await client.send("HDEL", [key, ...removeFields]));
          out.removed = removeFields;
        }

        out.length = asNumber(await client.send("HLEN", [key]));
        out.ttl = await applyTtl(client, key, ttl);
        return out;
      }),
    },
  ];
}
