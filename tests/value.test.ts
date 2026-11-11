// How values cross the boundary in both directions, and the two input parsers
// that would otherwise fail at a user rather than in a test.

import assert from "node:assert/strict";
import test from "node:test";

import { parseInfo } from "../src/redis/client.js";
import { decodeValue, encodeValue, jsonObjectInput, pairsToObject, splitCommandLine } from "../src/redis/value.js";
import { scoredMembers } from "../src/actions/sets.js";
import { rangeEntries, streamsEntries } from "../src/actions/streams.js";

test("writing renders objects as JSON and scalars as text", () => {
  assert.equal(encodeValue("plain"), "plain");
  assert.equal(encodeValue(42), "42");
  assert.equal(encodeValue(true), "true");
  assert.equal(encodeValue({ a: 1 }), '{"a":1}');
  assert.equal(encodeValue([1, "x"]), '[1,"x"]');
  assert.equal(encodeValue(null), "");
});

test('reading in "auto" parses only plain JSON objects and arrays', () => {
  assert.deepEqual(decodeValue('{"a":1}'), { a: 1 });
  assert.deepEqual(decodeValue("[1,2]"), [1, 2]);
  assert.equal(decodeValue("007"), "007", "a zero-padded code must stay text");
  assert.equal(decodeValue("42"), "42");
  assert.equal(decodeValue("true"), "true");
  assert.equal(decodeValue("{not json"), "{not json");
  assert.equal(decodeValue(null), null);
});

test('reading in "text" never parses, and "json" insists', () => {
  assert.equal(decodeValue('{"a":1}', "text"), '{"a":1}');
  assert.deepEqual(decodeValue("42", "json"), 42);
  assert.throws(() => decodeValue("nope", "json"), /not JSON/);
});

test("binary values survive as base64, text ones as text", () => {
  assert.equal(decodeValue(Buffer.from("hello")), "hello");
  const binary = Buffer.from([0xff, 0xfe, 0x00]);
  assert.equal(decodeValue(binary), binary.toString("base64"));
});

test("a flat field/value reply becomes an object", () => {
  assert.deepEqual(pairsToObject(["a", "1", "b", '{"c":2}']), { a: "1", b: { c: 2 } });
  assert.deepEqual(pairsToObject([]), {});
  assert.deepEqual(pairsToObject(null), {});
});

test("a command line splits like a shell", () => {
  assert.deepEqual(splitCommandLine("GET foo"), ["GET", "foo"]);
  assert.deepEqual(splitCommandLine('SET greeting "hello world"'), ["SET", "greeting", "hello world"]);
  assert.deepEqual(splitCommandLine("SET k 'a b'"), ["SET", "k", "a b"]);
  assert.deepEqual(splitCommandLine('SET k "say \\"hi\\""'), ["SET", "k", 'say "hi"']);
  assert.deepEqual(splitCommandLine('SET k ""'), ["SET", "k", ""], "an empty quoted argument is an argument");
  assert.deepEqual(splitCommandLine("   "), []);
  assert.throws(() => splitCommandLine('SET k "unbalanced'), /unbalanced/);
});

test("a JSON object input names the field when it is wrong", () => {
  assert.deepEqual(jsonObjectInput('{"a":1}', "fields"), { a: 1 });
  assert.throws(() => jsonObjectInput("", "fields"), /missing required input: fields/);
  assert.throws(() => jsonObjectInput("[1]", "fields"), /fields must be a JSON object/);
  assert.throws(() => jsonObjectInput("{bad", "fields"), /fields must be a JSON object/);
});

test("sorted-set members are accepted as an object or as entries", () => {
  assert.deepEqual(scoredMembers('{"alice":12,"bob":7.5}'), [
    { member: "alice", score: 12 },
    { member: "bob", score: 7.5 },
  ]);
  assert.deepEqual(scoredMembers('[{"member":"alice","score":12}]'), [{ member: "alice", score: 12 }]);
  assert.throws(() => scoredMembers('{"alice":"high"}'), /is not a number/);
  assert.throws(() => scoredMembers("[{}]"), /no "member"/);
  assert.throws(() => scoredMembers(""), /missing required input: members/);
  assert.throws(() => scoredMembers("{}"), /members is empty/);
});

test("stream replies parse into entries", () => {
  const range = [
    ["1700000000000-0", ["event", "paid", "orderId", "A-17"]],
    ["1700000000001-0", ["event", "shipped"]],
  ];
  assert.deepEqual(rangeEntries(range, "auto"), [
    { id: "1700000000000-0", fields: { event: "paid", orderId: "A-17" } },
    { id: "1700000000001-0", fields: { event: "shipped" } },
  ]);
  assert.deepEqual(streamsEntries([["orders", range]], "auto"), rangeEntries(range, "auto"));
  assert.deepEqual(streamsEntries(null, "auto"), [], "a blocking read that timed out is empty, not an error");
});

test("INFO parses into one object per section", () => {
  const info = parseInfo("# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:10\r\n\r\n# Clients\r\nconnected_clients:3\r\n");
  assert.equal(info.server.redis_version, "7.2.4");
  assert.equal(info.clients.connected_clients, "3");
});
