// The set and sorted-set actions. A set is membership (de-duplication, tags,
// "have I seen this id"); a sorted set is order (a leaderboard, a priority
// queue, a time-ordered index), so the two are grouped apart in the palette.

import type { Action } from "@inflowenger/node-plugin-sdk";

import type { Arg } from "../redis/client.js";
import { asNumber, asString, decodeMode, decodeValue, encodeValue } from "../redis/value.js";
import { applyTtl, bool, boolOr, capped, int, requireList, requireStr, str, type Kit, type Output } from "./kit.js";
import { setAddForm, setMembersForm, setRemoveForm, zsetAddForm, zsetRangeForm } from "./forms.js";
import { CLASS, M } from "./methods.js";

export function setActions(kit: Kit): Action[] {
  return [
    {
      method: M.setAdd,
      title: "Add set members",
      description:
        "Add members to a set (SADD) and report how many were new. Adding a member that is already there is not an error, which is what makes a set the cheapest way to de-duplicate.",
      icon: { icon: "mdi-shape-circle-plus" },
      tags: { class: CLASS.set },
      form: setAddForm,
      requestHandler: kit.run("set add", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const members = requireList(input.members, "members").map((member) => encodeValue(member));
        const ttl = int(input.ttlSeconds, 0, "ttlSeconds");

        await job.progress(50, { title: "set add", content: `${members.length} → ${key}` });

        const added = asNumber(await client.send("SADD", [key, ...members]));
        const size = asNumber(await client.send("SCARD", [key]));
        return { key, added, submitted: members.length, size, ttl: await applyTtl(client, key, ttl) };
      }),
    },

    {
      method: M.setRemove,
      title: "Remove set members",
      description: "Remove members from a set (SREM). Members that are not there are ignored.",
      icon: { icon: "mdi-shape-circle-plus" },
      tags: { class: CLASS.set },
      form: setRemoveForm,
      requestHandler: kit.run("set remove", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const members = requireList(input.members, "members").map((member) => encodeValue(member));

        await job.progress(50, { title: "set remove", content: `${members.length} from ${key}` });

        const removed = asNumber(await client.send("SREM", [key, ...members]));
        return { key, removed, submitted: members.length, size: asNumber(await client.send("SCARD", [key])) };
      }),
    },

    {
      method: M.setMembers,
      title: "Read set members",
      description:
        "Read a set's members, walked with SSCAN so a large set is paged rather than pulled in one reply, with its true size and an optional membership test.",
      icon: { icon: "mdi-shape-outline" },
      tags: { class: CLASS.set },
      form: setMembersForm,
      requestHandler: kit.run("set members", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const member = str(input.member);
        const maxMembers = capped(int(input.maxMembers, 1000, "maxMembers"), 100_000);
        const mode = decodeMode(input.decode);

        await job.progress(50, { title: "set members", content: key });

        const page = await client.scan({ key, command: "SSCAN", max: maxMembers });
        const out: Output = {
          key,
          members: page.items.map((item) => decodeValue(item, mode)),
          count: page.items.length,
          size: asNumber(await client.send("SCARD", [key])),
          truncated: !page.done,
          cursor: page.cursor,
        };
        if (member !== "") {
          out.member = member;
          out.contains = asNumber(await client.send("SISMEMBER", [key, member])) === 1;
        }
        return out;
      }),
    },

    {
      method: M.zsetAdd,
      title: "Add scored members",
      description:
        "Add or update members of a sorted set (ZADD), with the only-add / only-update and greater-than / less-than conditions, so a high-water mark needs no read first.",
      icon: { icon: "mdi-sort-numeric-variant" },
      tags: { class: CLASS.zset },
      form: zsetAddForm,
      requestHandler: kit.run("zset add", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const scored = scoredMembers(input.members);
        const mode = str(input.mode).toUpperCase();
        const update = str(input.update).toUpperCase();
        const ttl = int(input.ttlSeconds, 0, "ttlSeconds");

        if (mode !== "" && mode !== "NX" && mode !== "XX") {
          throw new Error(`condition must be empty, NX or XX: ${JSON.stringify(mode)}`);
        }
        if (update !== "" && update !== "GT" && update !== "LT") {
          throw new Error(`the score condition must be empty, GT or LT: ${JSON.stringify(update)}`);
        }
        if (mode === "NX" && update !== "") {
          throw new Error('NX cannot be combined with GT or LT — "only add new members" and a score comparison contradict each other');
        }

        const args: Arg[] = [key];
        if (mode !== "") args.push(mode);
        if (update !== "") args.push(update);
        for (const entry of scored) args.push(entry.score, entry.member);

        await job.progress(50, { title: "zset add", content: `${scored.length} → ${key}` });

        const added = asNumber(await client.send("ZADD", args));
        return {
          key,
          added,
          submitted: scored.length,
          size: asNumber(await client.send("ZCARD", [key])),
          ttl: await applyTtl(client, key, ttl),
        };
      }),
    },

    {
      method: M.zsetRange,
      title: "Read sorted-set range",
      description:
        "Read members in score order — a top-N by rank, or a score window — with their scores (ZRANGE; needs Redis 6.2+ for the score window and the reversed order).",
      icon: { icon: "mdi-podium" },
      tags: { class: CLASS.zset },
      form: zsetRangeForm,
      requestHandler: kit.run("zset range", async (job, client, input) => {
        const key = requireStr(input.key, "key");
        const by = str(input.by) === "score" ? "score" : "rank";
        const min = str(input.min) === "" ? (by === "score" ? "-inf" : "0") : str(input.min);
        const max = str(input.max) === "" ? (by === "score" ? "+inf" : "-1") : str(input.max);
        const reverse = bool(input.reverse);
        const withScores = boolOr(input.withScores, true);
        const limit = capped(int(input.limit, 100, "limit"), 10_000);

        const args: Arg[] = [key];
        if (by === "score") {
          // With REV the server wants the high bound first.
          args.push(...(reverse ? [max, min] : [min, max]), "BYSCORE");
          if (reverse) args.push("REV");
          args.push("LIMIT", 0, limit);
        } else {
          const start = int(min, 0, "min");
          const stop = int(max, -1, "max");
          args.push(start, stop);
          if (reverse) args.push("REV");
        }
        if (withScores) args.push("WITHSCORES");

        await job.progress(50, { title: "zset range", content: `${key} by ${by} ${min}..${max}` });

        const reply = (await client.send("ZRANGE", args)) as unknown[] | null;
        const flat = Array.isArray(reply) ? reply : [];

        const out: Output = { key, by, reversed: reverse, size: asNumber(await client.send("ZCARD", [key])) };

        if (withScores) {
          const entries: { member: unknown; score: number }[] = [];
          for (let i = 0; i + 1 < flat.length && entries.length < limit; i += 2) {
            entries.push({ member: decodeValue(flat[i], "text"), score: Number(asString(flat[i + 1])) });
          }
          out.entries = entries;
          out.members = entries.map((entry) => entry.member);
          out.count = entries.length;
        } else {
          const members = flat.slice(0, limit).map((item) => decodeValue(item, "text"));
          out.members = members;
          out.count = members.length;
        }
        return out;
      }),
    },
  ];
}

/**
 * scoredMembers reads the sorted-set input, which is accepted in the two shapes
 * a flow naturally produces: an object of member → score, and an array of
 * `{member, score}` entries (what a node that built a list of candidates has).
 */
export function scoredMembers(value: unknown): { member: string; score: number }[] {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error("missing required input: members (a JSON object or array)");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`members must be JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const out: { member: string; score: number }[] = [];

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error('each entry of the members array must be an object like {"member":"alice","score":12}');
      }
      const record = entry as Record<string, unknown>;
      const member = encodeValue(record.member ?? record.value ?? record.name);
      const score = Number(record.score ?? record.weight);
      if (member === "") throw new Error('an entry of the members array has no "member"');
      if (!Number.isFinite(score)) throw new Error(`member ${JSON.stringify(member)} has no numeric score`);
      out.push({ member, score });
    }
  } else if (typeof parsed === "object" && parsed !== null) {
    for (const [member, rawScore] of Object.entries(parsed as Record<string, unknown>)) {
      const score = Number(rawScore);
      if (!Number.isFinite(score)) {
        throw new Error(`the score of ${JSON.stringify(member)} is not a number: ${JSON.stringify(rawScore)}`);
      }
      out.push({ member, score });
    }
  } else {
    throw new Error("members must be a JSON object of member → score, or an array of {member, score} entries");
  }

  if (out.length === 0) throw new Error("members is empty — nothing to add");
  return out;
}
