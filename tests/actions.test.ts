// The actions, run against a real Redis. Every handler goes through the same
// path a node does — the {_registry, body} envelope, the settings profile, the
// {{$.path}} resolver, one terminal command — with only the Job faked.
//
// Set REDIS_TEST_URL to run it:
//
//   docker run -d --rm -p 6399:6379 redis:7-alpine
//   REDIS_TEST_URL=redis://localhost:6399/9 npm test
//
// The suite works inside its own key prefix and deletes it at the end, but it
// does write — point it at a scratch database, never a live one.

import assert from "node:assert/strict";
import test from "node:test";

import { M } from "../src/actions/methods.js";
import { Registry } from "../src/actions/registry.js";
import { call, ok } from "./harness.js";

const url = process.env.REDIS_TEST_URL ?? "";
const settings = { url };
const prefix = `inflow-test:${process.pid}`;
const k = (name: string) => `${prefix}:${name}`;

const registry = new Registry();

test(
  "the actions, against a live Redis",
  { skip: url === "" ? "set REDIS_TEST_URL to run the live suite" : false },
  async (t) => {
    t.after(async () => {
      await call(
        registry,
        M.keyDelete,
        { pattern: `${prefix}*`, confirmPattern: true, maxKeys: 100000 },
        settings,
      );
      await registry.close();
    });

    await t.test("set and get a string, with the key's type and ttl", async () => {
      const set = await ok(registry, M.keySet, { key: k("greeting"), value: "hello" }, settings);
      assert.equal(set.written, true);
      assert.equal(set.ttl, -1, "no expiry was asked for");

      const got = await ok(registry, M.keyGet, { key: k("greeting") }, settings);
      assert.equal(got.value, "hello");
      assert.equal(got.exists, true);
      assert.equal(got.type, "string");
    });

    await t.test("a missing key is a successful run, not an error", async () => {
      const got = await ok(registry, M.keyGet, { key: k("nope") }, settings);
      assert.equal(got.exists, false);
      assert.equal(got.value, null);
      assert.equal(got.ttl, -2);
    });

    await t.test("an object value round-trips as JSON", async () => {
      await ok(registry, M.keySet, { key: k("order"), value: '{"id":"A-17","total":42}' }, settings);
      const got = await ok(registry, M.keyGet, { key: k("order") }, settings);
      assert.deepEqual(got.value, { id: "A-17", total: 42 });

      const asText = await ok(registry, M.keyGet, { key: k("order"), decode: "text" }, settings);
      assert.equal(asText.value, '{"id":"A-17","total":42}');
    });

    await t.test("{{$.path}} tokens are resolved against the flow", async () => {
      const out = await ok(
        registry,
        M.keySet,
        { key: k("tenant:{{$.trigger.tenantId}}"), value: "{{$.trigger.name}}" },
        settings,
        { "$.trigger.tenantId": "42", "$.trigger.name": "acme" },
      );
      assert.equal(out.key, k("tenant:42"));
      const got = await ok(registry, M.keyGet, { key: k("tenant:42") }, settings);
      assert.equal(got.value, "acme");
    });

    await t.test("an expiry, a condition and the previous value", async () => {
      const withTtl = await ok(registry, M.keySet, { key: k("ttl"), value: "v", ttlSeconds: 60 }, settings);
      assert.ok(Number(withTtl.ttl) > 0 && Number(withTtl.ttl) <= 60);

      const nx = await ok(registry, M.keySet, { key: k("ttl"), value: "other", mode: "NX" }, settings);
      assert.equal(nx.written, false, "NX must not overwrite an existing key");

      const nxWithGet = await ok(
        registry,
        M.keySet,
        { key: k("ttl"), value: "other", mode: "NX", returnOld: true },
        settings,
      );
      assert.equal(nxWithGet.written, false);
      assert.equal(nxWithGet.previous, "v", "the previous value is reported even when the write was skipped");

      const replaced = await ok(registry, M.keySet, { key: k("ttl"), value: "new", returnOld: true }, settings);
      assert.equal(replaced.previous, "v");
      assert.equal(replaced.written, true);

      const bad = await call(registry, M.keySet, { key: k("ttl"), value: "v", ttlSeconds: 10, keepTtl: true }, settings);
      assert.match(String(bad.error), /cannot both be set/);
    });

    await t.test("expiry: seconds, timestamp and persist", async () => {
      await ok(registry, M.keySet, { key: k("expiring"), value: "v" }, settings);

      const seconds = await ok(registry, M.keyExpire, { key: k("expiring"), mode: "seconds", ttlSeconds: 120 }, settings);
      assert.equal(seconds.applied, true);
      assert.ok(Number(seconds.ttl) > 100);

      const at = await ok(
        registry,
        M.keyExpire,
        { key: k("expiring"), mode: "at", atUnix: Math.floor(Date.now() / 1000) + 300 },
        settings,
      );
      assert.equal(at.applied, true);
      assert.ok(Number(at.ttl) > 200);

      const persisted = await ok(registry, M.keyExpire, { key: k("expiring"), mode: "persist" }, settings);
      assert.equal(persisted.applied, true);
      assert.equal(persisted.ttl, -1);

      const missing = await call(registry, M.keyExpire, { key: k("expiring"), mode: "at", atUnix: 0 }, settings);
      assert.match(String(missing.error), /missing required input: atUnix/);
    });

    await t.test("reading a key of the wrong type says which action to use", async () => {
      await ok(registry, M.listPush, { key: k("queue"), values: ["a"] }, settings);
      const run = await call(registry, M.keyGet, { key: k("queue") }, settings);
      assert.match(String(run.error), /holds a list, not a string/);
      assert.match(String(run.error), /Read list range/);
    });

    await t.test("a counter increments atomically, in whole and fractional steps", async () => {
      const first = await ok(registry, M.counterIncrement, { key: k("hits"), by: 1, ttlSeconds: 60 }, settings);
      assert.equal(first.value, 1);
      assert.equal(first.expirySet, true);
      const ttlAfterFirst = Number(first.ttl);

      const second = await ok(registry, M.counterIncrement, { key: k("hits"), by: 4, ttlSeconds: 60 }, settings);
      assert.equal(second.value, 5);
      assert.equal(second.expirySet, false, "the window must not be extended on every hit");
      assert.ok(Number(second.ttl) <= ttlAfterFirst);

      const float = await ok(registry, M.counterIncrement, { key: k("score"), by: 1.5 }, settings);
      assert.equal(float.value, 1.5);
      assert.equal(float.command, "INCRBYFLOAT");

      const field = await ok(registry, M.counterIncrement, { key: k("stats"), field: "views", by: 3 }, settings);
      assert.equal(field.value, 3);
      assert.equal(field.command, "HINCRBY");
    });

    await t.test("a hash is written, read, pruned", async () => {
      const written = await ok(
        registry,
        M.hashSet,
        { key: k("order:1"), fields: '{"status":"paid","items":2,"meta":{"source":"web"}}' },
        settings,
      );
      assert.equal(written.fieldsWritten, 3);
      assert.equal(written.created, 3);

      const read = await ok(registry, M.hashGet, { key: k("order:1") }, settings);
      assert.deepEqual(read.fields, { status: "paid", items: "2", meta: { source: "web" } });
      assert.equal(read.exists, true);

      const some = await ok(registry, M.hashGet, { key: k("order:1"), fields: ["status", "ghost"] }, settings);
      assert.deepEqual(some.fields, { status: "paid", ghost: null });
      assert.deepEqual(some.missingFields, ["ghost"]);

      const nx = await ok(
        registry,
        M.hashSet,
        { key: k("order:1"), fields: '{"status":"shipped","carrier":"dhl"}', onlyIfMissing: true },
        settings,
      );
      assert.deepEqual(nx.fields, ["carrier"]);
      assert.deepEqual(nx.skipped, ["status"]);

      const pruned = await ok(
        registry,
        M.hashSet,
        { key: k("order:1"), fields: "", removeFields: ["meta"] },
        settings,
      );
      assert.equal(pruned.fieldsRemoved, 1);

      const nothing = await call(registry, M.hashSet, { key: k("order:1") }, settings);
      assert.match(String(nothing.error), /nothing to write/);
    });

    await t.test("a list works as a queue, and can be capped", async () => {
      const pushed = await ok(registry, M.listPush, { key: k("jobs"), values: ["a", "b", "c"] }, settings);
      assert.equal(pushed.length, 3);
      assert.equal(pushed.pushed, 3);

      const range = await ok(registry, M.listRange, { key: k("jobs") }, settings);
      assert.deepEqual(range.values, ["a", "b", "c"]);
      assert.equal(range.length, 3);

      const popped = await ok(registry, M.listPop, { key: k("jobs") }, settings);
      assert.deepEqual(popped.values, ["a"], "a left pop after a right push is FIFO");
      assert.equal(popped.length, 2);

      const many = await ok(registry, M.listPop, { key: k("jobs"), count: 5 }, settings);
      assert.deepEqual(many.values, ["b", "c"]);

      const empty = await ok(registry, M.listPop, { key: k("jobs") }, settings);
      assert.equal(empty.empty, true);
      assert.deepEqual(empty.values, []);

      const capped = await ok(
        registry,
        M.listPush,
        { key: k("recent"), values: ["1", "2", "3", "4", "5"], maxLength: 3 },
        settings,
      );
      assert.equal(capped.trimmed, true);
      assert.equal(capped.length, 3);
      const kept = await ok(registry, M.listRange, { key: k("recent") }, settings);
      assert.deepEqual(kept.values, ["3", "4", "5"], "the newest items are the ones kept");

      const notThere = await ok(registry, M.listPush, { key: k("absent"), values: ["x"], onlyIfExists: true }, settings);
      assert.equal(notThere.length, 0);
      assert.equal(notThere.pushed, 0);
    });

    await t.test("a waiting pop answers when its own timeout expires", async () => {
      const started = Date.now();
      const run = await ok(registry, M.listPop, { key: k("idle"), blockSeconds: 1 }, settings);
      assert.equal(run.empty, true);
      assert.equal(run.command, "BLPOP");
      assert.ok(Date.now() - started >= 900, "it really waited");
    });

    await t.test("a waiting pop takes an item pushed while it waits", async () => {
      const waiting = ok(registry, M.listPop, { key: k("handoff"), blockSeconds: 5 }, settings);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await ok(registry, M.listPush, { key: k("handoff"), values: ["work"] }, settings);
      const run = await waiting;
      assert.deepEqual(run.values, ["work"]);
      assert.equal(run.waited, true);
    });

    await t.test("a set de-duplicates, and reports membership", async () => {
      const added = await ok(registry, M.setAdd, { key: k("tags"), members: ["a", "b", "a"] }, settings);
      assert.equal(added.added, 2, "the repeat is not an error, it just adds nothing");
      assert.equal(added.size, 2);

      const members = await ok(registry, M.setMembers, { key: k("tags"), member: "b" }, settings);
      assert.deepEqual([...(members.members as string[])].sort(), ["a", "b"]);
      assert.equal(members.contains, true);
      assert.equal(members.size, 2);
      assert.equal(members.truncated, false);

      const removed = await ok(registry, M.setRemove, { key: k("tags"), members: ["a", "ghost"] }, settings);
      assert.equal(removed.removed, 1);
      assert.equal(removed.size, 1);
    });

    await t.test("a sorted set keeps order, by rank and by score", async () => {
      await ok(registry, M.zsetAdd, { key: k("board"), members: '{"alice":12,"bob":7,"cara":30}' }, settings);

      const top = await ok(registry, M.zsetRange, { key: k("board"), by: "rank", min: "0", max: "1", reverse: true }, settings);
      assert.deepEqual(top.entries, [
        { member: "cara", score: 30 },
        { member: "alice", score: 12 },
      ]);
      assert.equal(top.size, 3);

      const window = await ok(
        registry,
        M.zsetRange,
        { key: k("board"), by: "score", min: "10", max: "+inf" },
        settings,
      );
      assert.deepEqual(window.members, ["alice", "cara"]);

      const withoutScores = await ok(
        registry,
        M.zsetRange,
        { key: k("board"), by: "rank", min: "0", max: "-1", withScores: false },
        settings,
      );
      assert.deepEqual(withoutScores.members, ["bob", "alice", "cara"]);

      const gt = await ok(
        registry,
        M.zsetAdd,
        { key: k("board"), members: '{"alice":5}', update: "GT" },
        settings,
      );
      assert.equal(gt.added, 0);
      const unchanged = await ok(registry, M.zsetRange, { key: k("board"), by: "score", min: "12", max: "12" }, settings);
      assert.deepEqual(unchanged.members, ["alice"], "GT must not lower an existing score");

      const contradiction = await call(
        registry,
        M.zsetAdd,
        { key: k("board"), members: '{"x":1}', mode: "NX", update: "GT" },
        settings,
      );
      assert.match(String(contradiction.error), /NX cannot be combined/);

      const entries = await ok(
        registry,
        M.zsetAdd,
        { key: k("board2"), members: '[{"member":"dan","score":1}]' },
        settings,
      );
      assert.equal(entries.added, 1);
    });

    await t.test("a stream is appended to and read back three ways", async () => {
      const first = await ok(
        registry,
        M.streamAdd,
        { key: k("events"), fields: '{"event":"order.paid","orderId":"A-17"}' },
        settings,
      );
      assert.match(String(first.id), /^\d+-\d+$/);
      assert.equal(first.length, 1);

      await ok(registry, M.streamAdd, { key: k("events"), fields: '{"event":"order.shipped"}' }, settings);

      const range = await ok(registry, M.streamRead, { key: k("events"), mode: "range" }, settings);
      assert.equal(range.count, 2);
      assert.deepEqual((range.entries as { fields: Record<string, unknown> }[])[0].fields, {
        event: "order.paid",
        orderId: "A-17",
      });
      assert.equal(range.lastId, (range.entries as { id: string }[])[1].id);

      const latest = await ok(
        registry,
        M.streamRead,
        { key: k("events"), mode: "range", reverse: true, count: 1 },
        settings,
      );
      assert.equal(latest.count, 1);
      assert.deepEqual((latest.entries as { fields: Record<string, unknown> }[])[0].fields, {
        event: "order.shipped",
      });

      const since = await ok(registry, M.streamRead, { key: k("events"), mode: "new", lastId: "0" }, settings);
      assert.equal(since.count, 2, "reading from id 0 is the whole stream");

      const group = await ok(
        registry,
        M.streamRead,
        { key: k("events"), mode: "group", group: "workers", consumer: "w1", createGroup: true },
        settings,
      );
      assert.equal(group.count, 0, "a new group starts at the end of the stream");

      await ok(registry, M.streamAdd, { key: k("events"), fields: '{"event":"order.closed"}' }, settings);
      const batch = await ok(
        registry,
        M.streamRead,
        { key: k("events"), mode: "group", group: "workers", consumer: "w1", createGroup: true, ack: true },
        settings,
      );
      assert.equal(batch.count, 1);
      assert.equal(batch.acked, 1);

      const again = await ok(
        registry,
        M.streamRead,
        { key: k("events"), mode: "group", group: "workers", consumer: "w1" },
        settings,
      );
      assert.equal(again.count, 0, "an acknowledged entry is not redelivered");

      const capped = await ok(
        registry,
        M.streamAdd,
        { key: k("capped"), fields: '{"n":1}', maxLength: 1 },
        settings,
      );
      assert.ok(Number(capped.length) >= 1);
    });

    await t.test("publishing to nobody is a successful run with no receivers", async () => {
      const out = await ok(registry, M.publish, { channel: k("chan"), message: '{"hello":"world"}' }, settings);
      assert.equal(out.receivers, 0);
      assert.equal(out.delivered, false);
    });

    await t.test("scan walks the keyspace and commits a cursor", async () => {
      for (const n of [1, 2, 3]) {
        await ok(registry, M.keySet, { key: k(`scan:${n}`), value: String(n) }, settings);
      }

      const page = await ok(registry, M.keyScan, { pattern: `${prefix}:scan:*` }, settings);
      assert.equal(page.count, 3);
      assert.equal(page.done, true);
      assert.equal(page.cursor, "0");

      const typed = await ok(registry, M.keyScan, { pattern: `${prefix}:scan:*`, type: "list" }, settings);
      assert.equal(typed.count, 0, "the type filter is applied by the server");

      const oneAtATime = await ok(registry, M.keyScan, { pattern: `${prefix}:scan:*`, maxKeys: 1 }, settings);
      assert.equal(oneAtATime.count, 1);
      assert.equal(oneAtATime.done, false, "the cursor says there is more");
    });

    await t.test("inspect reports the type, ttl and size of each key", async () => {
      const out = await ok(
        registry,
        M.keyInspect,
        { keys: [k("greeting"), k("order:1"), k("board"), k("nope")] },
        settings,
      );
      const byKey = Object.fromEntries(
        (out.keys as Record<string, unknown>[]).map((entry) => [entry.key as string, entry]),
      );
      assert.equal(byKey[k("greeting")].type, "string");
      assert.equal(byKey[k("order:1")].type, "hash");
      assert.equal(byKey[k("board")].type, "zset");
      assert.equal(byKey[k("board")].size, 3);
      assert.equal(byKey[k("nope")].exists, false);
      assert.deepEqual(out.missing, [k("nope")]);
    });

    await t.test("delete by name, and by pattern once it is confirmed", async () => {
      const byName = await ok(registry, M.keyDelete, { keys: [k("scan:1"), k("gone")] }, settings);
      assert.equal(byName.deleted, 1, "a missing key is not an error");
      assert.equal(byName.command, "UNLINK");

      const unconfirmed = await call(registry, M.keyDelete, { pattern: `${prefix}:scan:*` }, settings);
      assert.match(String(unconfirmed.error), /until the confirmation checkbox is on/);

      const everything = await call(registry, M.keyDelete, { pattern: "*", confirmPattern: true }, settings);
      assert.match(String(everything.error), /refusing the pattern/);

      const byPattern = await ok(
        registry,
        M.keyDelete,
        { pattern: `${prefix}:scan:*`, confirmPattern: true },
        settings,
      );
      assert.equal(byPattern.deleted, 2);
      assert.equal(byPattern.truncated, false);

      const nothing = await call(registry, M.keyDelete, {}, settings);
      assert.match(String(nothing.error), /name at least one key, or give a pattern/);
    });

    await t.test("the raw command action runs what the typed ones do not", async () => {
      await ok(registry, M.command, { command: `SETRANGE ${k("page")} 0 "hello world"` }, settings);
      const got = await ok(registry, M.command, { command: `GETRANGE ${k("page")} 0 4` }, settings);
      assert.equal(got.reply, "hello");
      assert.equal(got.command, "GETRANGE");

      const withArgs = await ok(
        registry,
        M.command,
        { command: "SET", args: [k("spaced"), "a value with spaces"] },
        settings,
      );
      assert.equal(withArgs.reply, "OK");
      const back = await ok(registry, M.keyGet, { key: k("spaced") }, settings);
      assert.equal(back.value, "a value with spaces");

      const refused = await call(registry, M.command, { command: "SUBSCRIBE news" }, settings);
      assert.match(String(refused.error), /cannot be run from a node/);

      const unknown = await call(registry, M.command, { command: "NOSUCHCOMMAND x" }, settings);
      assert.match(String(unknown.error), /unknown command/i);
    });

    await t.test("server info reports the version and the key count", async () => {
      const out = await ok(registry, M.serverInfo, { section: "default" }, settings);
      const summary = out.summary as Record<string, unknown>;
      assert.match(String(summary.version), /^\d+\./);
      assert.ok(Number(out.dbSize) > 0);
      assert.equal(out.connection, (out.connection as string).includes(":") ? out.connection : "");
      assert.ok((out.info as Record<string, unknown>).server, "the parsed INFO carries its sections");
    });

    await t.test("a node with no connection says how to fix it", async () => {
      const run = await call(registry, M.keyGet, { key: "x" }, {});
      assert.match(String(run.error), /pick a settings profile in the node drawer/);
    });

    await t.test("an unreachable server is reported, not hung", async () => {
      const run = await call(registry, M.keyGet, { key: "x" }, { url: "redis://127.0.0.1:6/0" });
      assert.ok(run.error, "it has to fail");
      assert.equal(run.finishes, 1, "exactly one terminal command");
    });

    await t.test("every run finished exactly once", async () => {
      const run = await call(registry, M.keyGet, { key: k("greeting") }, settings);
      assert.equal(run.finishes, 1);
      assert.ok(run.frames.length >= 2, "progress was reported");
    });
  },
);
