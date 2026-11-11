// Turns the settings profile the platform ships with every call into a live
// Redis connection, and pools one client per distinct connection.
//
// The plugin holds no server configuration of its own. A connection travels in
// each request as `body.settings`, the same named profile the runtime folds into
// action bodies — so one running plugin can serve many Redis servers and
// rotating a password needs no redeploy. The counterpart of the ClickHouse
// plugin's src/clickhouse/settings.ts.

import { createHash } from "node:crypto";

import { Client } from "./client.js";

/**
 * ErrNoSettings is thrown when a call arrives without a connection. It is phrased
 * for the person looking at the node, since that is where the fix is.
 */
export const ErrNoSettings =
  "this node has no Redis connection: pick a settings profile in the node drawer (URL, or host / port / password / database) or create one from the plugin's set-up form";

/** connectTimeoutMs bounds opening the socket. */
const connectTimeoutMs = 10_000;

/**
 * Config is a resolved Redis connection. Either a full URL is given, or the
 * discrete fields are; both are reduced to what `ioredis` needs.
 */
export interface Config {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Logical database index (SELECT). 0 unless configured. */
  db: number;
  /** Connect over TLS (rediss://). */
  tls: boolean;
  /** Verify the server certificate. False only when explicitly asked for. */
  tlsVerify: boolean;
  /** host:port/db — enough to name the target, with no credentials in it. */
  connInfo: string;
  connectTimeoutMs: number;
}

// Field synonyms, in preference order. Each entry is already canonical (lower
// case, letters and digits only) — see canonicalKey.
const urlKeys = ["url", "dsn", "uri", "connectionstring", "connstring", "connectionurl", "connuri", "redisurl"];
const hostKeys = ["host", "hostname", "server", "address", "endpoint"];
const portKeys = ["port"];
const dbKeys = ["db", "database", "dbindex", "dbnumber", "index", "databaseindex"];
const userKeys = ["username", "user", "login", "acl", "aclusername"];
const passwordKeys = ["password", "pass", "pwd", "secret", "auth", "requirepass", "token", "apikey"];
const tlsKeys = ["tls", "ssl", "secure", "usetls", "usessl"];
const insecureKeys = ["tlsinsecure", "insecure", "insecureskipverify", "allowselfsigned", "skipverify"];

/**
 * parseConfig reads a connection out of the settings profile the platform ships
 * with every action call as `body.settings`.
 *
 * The profile is a free-form key/value record: filled from the plugin's own
 * set-up form when the platform could read it, and hand-typed otherwise. So keys
 * are matched leniently — case, spaces, dashes and underscores are ignored, and
 * the usual synonyms for each field are accepted.
 */
export function parseConfig(settings: Record<string, unknown> | undefined): Config {
  if (!settings || Object.keys(settings).length === 0) {
    throw new Error(ErrNoSettings);
  }

  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(settings)) {
    const text = toText(value);
    if (text !== "") values.set(canonicalKey(key), text);
  }

  const rawUrl = pick(values, urlKeys);
  const host = pick(values, hostKeys);

  if (rawUrl === "" && host === "") {
    // Something was configured, but none of it is a Redis connection — most
    // likely the wrong profile is selected on the node.
    throw new Error(
      `${ErrNoSettings} (the selected profile has none of these: ${Object.keys(settings).sort().join(", ")})`,
    );
  }

  const tlsAsked = isTruthy(pick(values, tlsKeys));
  const tlsVerify = !isTruthy(pick(values, insecureKeys));

  let cfgHost = host;
  let cfgPort = toInt(pick(values, portKeys), 6379);
  let username = pick(values, userKeys);
  let password = pick(values, passwordKeys);
  let db = toInt(pick(values, dbKeys), 0);
  let tls = tlsAsked;

  if (rawUrl !== "") {
    // A URL given verbatim wins outright — a user who pasted one means it. The
    // discrete fields still fill in what the URL leaves out, so a profile can
    // keep the password out of the URL.
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `redis://${rawUrl}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid Redis URL: ${rawUrl}`);
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== "redis" && scheme !== "rediss") {
      throw new Error(`invalid Redis URL scheme ${JSON.stringify(scheme)}: use redis:// or rediss://`);
    }
    tls = tlsAsked || scheme === "rediss";
    cfgHost = parsed.hostname || host || "localhost";
    cfgPort = parsed.port !== "" ? Number(parsed.port) : cfgPort;
    if (parsed.username !== "") username = decodeURIComponent(parsed.username);
    if (parsed.password !== "") password = decodeURIComponent(parsed.password);
    const path = parsed.pathname.replace(/^\//, "");
    if (path !== "") {
      const n = Number(path);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`invalid database index in Redis URL: ${JSON.stringify(path)}`);
      }
      db = n;
    }
  }

  if (cfgHost === "") cfgHost = "localhost";

  return {
    host: cfgHost,
    port: cfgPort,
    username,
    password,
    db,
    tls,
    tlsVerify,
    connInfo: `${cfgHost}:${cfgPort}/${db}`,
    connectTimeoutMs,
  };
}

/** fingerprint identifies a connection without keeping the password in a map key. */
function fingerprint(cfg: Config): string {
  return createHash("sha256")
    .update([cfg.host, cfg.port, cfg.username, cfg.password, cfg.db, cfg.tls, cfg.tlsVerify].join("\n"))
    .digest("hex");
}

// maxPooledClients bounds the cache: a handful of profiles is the norm, and the
// pool is drained rather than grown without limit if that ever changes.
const maxPooledClients = 16;

/**
 * Pool hands out one client per distinct connection, so every job using the same
 * settings profile shares one socket instead of opening afresh. A Redis
 * connection is stateful and long-lived, which is exactly why it must not be a
 * package-level singleton: one process serves many profiles at once.
 */
export class Pool {
  private readonly clients = new Map<string, Client>();

  /** Resolve the settings profile shipped with a call into a client. */
  client(settings: Record<string, unknown> | undefined): Client {
    return this.for(parseConfig(settings));
  }

  /** Return the client for an already-parsed config, opening one on first use. */
  for(cfg: Config): Client {
    const key = fingerprint(cfg);
    const existing = this.clients.get(key);
    if (existing) return existing;

    if (this.clients.size >= maxPooledClients) {
      for (const [k, c] of this.clients) {
        void c.close();
        this.clients.delete(k);
      }
    }
    const client = new Client(cfg);
    this.clients.set(key, client);
    return client;
  }

  /** Close every pooled client. For shutdown and for tests. */
  async closeAll(): Promise<void> {
    const open = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(open.map((c) => c.close()));
  }
}

// ---------------------------------------------------------------- helpers --

function pick(values: Map<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined) return value;
  }
  return "";
}

// canonicalKey reduces a settings key to letters and digits, lower case, so
// "Host name", "host_name" and "hostName" are one key.
function canonicalKey(key: string): string {
  let out = "";
  for (const ch of key.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
  }
  return out;
}

// toText renders a profile value. The settings editor stores anything that
// parses as JSON (numbers, booleans) as that type, so values are not always
// strings — a port arrives as a number.
function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value).trim();
}

function toInt(value: string, fallback: number): number {
  if (value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid number in the connection profile: ${JSON.stringify(value)}`);
  }
  return n;
}

function isTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on" || v === "require" || v === "rediss";
}
