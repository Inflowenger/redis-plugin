// The settings profile is typed by hand as often as it is filled in by a form,
// so the lenient key matcher is worth as much as the parser itself.

import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/redis/settings.js";

test("discrete fields", () => {
  const cfg = parseConfig({ host: "cache.internal", port: 6380, db: 2, username: "app", password: "s3cret" });
  assert.equal(cfg.host, "cache.internal");
  assert.equal(cfg.port, 6380);
  assert.equal(cfg.db, 2);
  assert.equal(cfg.username, "app");
  assert.equal(cfg.password, "s3cret");
  assert.equal(cfg.tls, false);
  assert.equal(cfg.connInfo, "cache.internal:6380/2");
});

test("a URL wins and carries user, password and database", () => {
  const cfg = parseConfig({ url: "redis://app:s3cret@cache.internal:6380/3", host: "ignored" });
  assert.equal(cfg.host, "cache.internal");
  assert.equal(cfg.port, 6380);
  assert.equal(cfg.db, 3);
  assert.equal(cfg.username, "app");
  assert.equal(cfg.password, "s3cret");
});

test("rediss:// implies TLS, and a tls flag also does", () => {
  assert.equal(parseConfig({ url: "rediss://cache.internal:6380" }).tls, true);
  assert.equal(parseConfig({ host: "cache.internal", ssl: "true" }).tls, true);
  assert.equal(parseConfig({ host: "cache.internal", secure: 1 }).tls, true);
  assert.equal(parseConfig({ host: "cache.internal" }).tls, false);
});

test("certificate verification is on unless it is turned off", () => {
  assert.equal(parseConfig({ url: "rediss://h" }).tlsVerify, true);
  assert.equal(parseConfig({ url: "rediss://h", tlsInsecure: true }).tlsVerify, false);
  assert.equal(parseConfig({ url: "rediss://h", "insecure skip verify": "yes" }).tlsVerify, false);
});

test("keys are matched ignoring case, spaces, dashes and underscores", () => {
  const cfg = parseConfig({ "Host Name": "cache.internal", PORT: "6381", "DB-Index": "4", Pass: "p" });
  assert.equal(cfg.host, "cache.internal");
  assert.equal(cfg.port, 6381);
  assert.equal(cfg.db, 4);
  assert.equal(cfg.password, "p");
});

test("a bare host:port is accepted as a URL", () => {
  const cfg = parseConfig({ url: "cache.internal:6390" });
  assert.equal(cfg.host, "cache.internal");
  assert.equal(cfg.port, 6390);
});

test("a port defaults to 6379 and a database to 0", () => {
  const cfg = parseConfig({ host: "localhost" });
  assert.equal(cfg.port, 6379);
  assert.equal(cfg.db, 0);
});

test("no settings at all names the fix", () => {
  assert.throws(() => parseConfig(undefined), /pick a settings profile/);
  assert.throws(() => parseConfig({}), /pick a settings profile/);
});

test("the wrong profile lists the keys it did contain", () => {
  assert.throws(
    () => parseConfig({ projectKey: "OPS", apiToken: "x" }),
    /the selected profile has none of these: apiToken, projectKey/,
  );
});

test("a URL that is not Redis is refused by scheme", () => {
  assert.throws(() => parseConfig({ url: "postgres://localhost:5432/app" }), /use redis:\/\/ or rediss:\/\//);
});

test("a profile value that should be a number but is not", () => {
  assert.throws(() => parseConfig({ host: "localhost", port: "six" }), /invalid number/);
  assert.throws(() => parseConfig({ url: "redis://localhost:6379/zero" }), /invalid database index/);
});
