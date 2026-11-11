// A ready-to-use Redis connection for one settings profile. Every action in the
// plugin goes through `send` (one command) or `batch` (a pipeline), so there is
// exactly one place where a command reaches the server — which is also what lets
// the raw-command action share the typed actions' plumbing.
//
// Values are always passed as command arguments, never spliced into a command
// string, so a value can never become a command.

import { Redis, type RedisOptions } from "ioredis";

import type { Config } from "./settings.js";

/** An argument a Redis command accepts on the wire. */
export type Arg = string | number | Buffer;

/** One command as [name, ...args] — the shape a pipeline entry takes. */
export type Cmd = [string, ...Arg[]];

/** What a SCAN-family iteration returns. */
export interface ScanPage {
  /** The items this page produced (keys for SCAN, members for SSCAN). */
  items: string[];
  /** The cursor to continue from. "0" means the iteration is complete. */
  cursor: string;
  /** True when the iteration finished rather than hitting the cap. */
  done: boolean;
}

// Commands that park the connection waiting for data. They are run on their own
// socket so they never hold up the pooled client, and they are what the raw
// command action routes away from the shared connection.
const blockingCommands = new Set([
  "BLPOP",
  "BRPOP",
  "BLMOVE",
  "BLMPOP",
  "BRPOPLPUSH",
  "BZPOPMIN",
  "BZPOPMAX",
  "BZMPOP",
  "WAIT",
  "WAITAOF",
  "XREAD",
  "XREADGROUP",
]);

// Commands that take the connection out of request/reply mode for good. A plugin
// action is one request and one reply, so there is no way to serve these: they
// would hold the socket open and answer nothing.
const unsupportedCommands = new Set([
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "PSUBSCRIBE",
  "PUNSUBSCRIBE",
  "SSUBSCRIBE",
  "SUNSUBSCRIBE",
  "MONITOR",
  "RESET",
  "SELECT",
  "SWAPDB",
  "SHUTDOWN",
]);

/** isBlocking reports whether a command parks the connection. */
export function isBlocking(command: string): boolean {
  return blockingCommands.has(command.toUpperCase());
}

/** isUnsupported reports whether a command cannot be served by one request/reply. */
export function isUnsupported(command: string): boolean {
  return unsupportedCommands.has(command.toUpperCase());
}

export class Client {
  private readonly redis: Redis;
  /** host:port/db — no credentials in it. */
  readonly connInfo: string;
  /** The logical database every command on this client runs against. */
  readonly db: number;
  private readonly options: RedisOptions;
  private lastErrorLoggedAt = 0;

  constructor(cfg: Config) {
    this.options = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username !== "" ? cfg.username : undefined,
      password: cfg.password !== "" ? cfg.password : undefined,
      db: cfg.db,
      tls: cfg.tls ? { rejectUnauthorized: cfg.tlsVerify, servername: cfg.host } : undefined,
      // Lazy: no socket is opened until the first command, so constructing a
      // client for a profile that is never used costs nothing.
      lazyConnect: true,
      connectTimeout: cfg.connectTimeoutMs,
      // Fail a command reasonably fast while the client keeps trying to
      // reconnect in the background — a node should report "cannot reach Redis"
      // rather than hang until the flow times out.
      maxRetriesPerRequest: 2,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
      keepAlive: 30_000,
      connectionName: "inflow-redis-plugin",
      enableReadyCheck: true,
    };
    this.redis = new Redis(this.options);
    this.watch(this.redis);
    this.connInfo = cfg.connInfo;
    this.db = cfg.db;
  }

  /** Close the connection. Called when a client is evicted from the pool. */
  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  /** Ping verifies the connection is live, for the "Test connection" button. */
  async ping(): Promise<string> {
    const reply = await this.redis.ping();
    return String(reply);
  }

  /** Run one command and return its reply verbatim. */
  async send(command: string, args: Arg[] = []): Promise<unknown> {
    return this.redis.call(command, args);
  }

  /**
   * Run one command on a socket of its own and close it afterwards, for the
   * commands that park the connection (BLPOP, XREAD BLOCK, WAIT). `budgetMs`
   * is a backstop: the server should answer by itself when its own timeout
   * expires, and if it does not, the socket is dropped rather than left hanging.
   */
  async sendBlocking(command: string, args: Arg[], budgetMs: number): Promise<unknown> {
    const conn = this.redis.duplicate({
      lazyConnect: true,
      // A blocking command must not be abandoned mid-wait by a retry counter.
      maxRetriesPerRequest: null,
      connectionName: "inflow-redis-plugin/blocking",
    });
    this.watch(conn);

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        conn.call(command, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${command.toUpperCase()} did not answer within ${Math.round(budgetMs / 1000)}s`)),
            budgetMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      conn.disconnect();
    }
  }

  /**
   * Run several commands in one round trip. The first failure is thrown unless
   * `tolerant` is set, in which case a failed command's slot holds the Error and
   * the caller decides — used where a command is allowed to be unavailable
   * (MEMORY USAGE on a server that disabled it).
   */
  async batch(cmds: Cmd[], tolerant = false): Promise<unknown[]> {
    if (cmds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const [command, ...args] of cmds) {
      pipeline.call(command, args as Arg[]);
    }
    const replies = await pipeline.exec();
    if (!replies) throw new Error("the pipeline returned no replies");

    return replies.map(([err, value]) => {
      if (err) {
        if (!tolerant) throw err;
        return err;
      }
      return value;
    });
  }

  /**
   * Iterate SCAN (or SSCAN / HSCAN / ZSCAN when `key` is given) from `cursor`
   * until the iteration completes or `max` items have been collected. Redis
   * returns an unspecified number of items per call — a cursor loop is the only
   * safe way to walk a keyspace, which is why KEYS is nowhere in this plugin.
   */
  async scan(opts: {
    /** SCAN over the keyspace when empty; SSCAN/HSCAN/ZSCAN over this key. */
    key?: string;
    command?: "SCAN" | "SSCAN" | "HSCAN" | "ZSCAN";
    match?: string;
    /** SCAN only: restrict to keys of this type. */
    type?: string;
    /** Hint for how much work one round trip does. */
    count?: number;
    max: number;
    cursor?: string;
  }): Promise<ScanPage> {
    const command = opts.command ?? (opts.key ? "SSCAN" : "SCAN");
    // Asking for more per round trip than the caller will keep only makes the
    // server do work that is thrown away.
    const count = opts.count && opts.count > 0 ? opts.count : Math.min(500, Math.max(opts.max, 10));
    const items: string[] = [];
    let cursor = opts.cursor && opts.cursor !== "" ? opts.cursor : "0";
    let truncated = false;
    let rounds = 0;

    do {
      const args: Arg[] = [];
      if (opts.key) args.push(opts.key);
      args.push(cursor);
      if (opts.match && opts.match !== "") args.push("MATCH", opts.match);
      args.push("COUNT", count);
      if (command === "SCAN" && opts.type && opts.type !== "") args.push("TYPE", opts.type);

      const previous = cursor;
      const reply = (await this.send(command, args)) as [string, string[]];
      const next = String(reply[0]);
      const batch = reply[1] ?? [];

      let taken = 0;
      for (const item of batch) {
        if (items.length >= opts.max) break;
        items.push(String(item));
        taken++;
      }

      if (taken < batch.length) {
        // The cap cut this page in half. SCAN cannot resume inside a page, so
        // the cursor that produced it is handed back: continuing from it repeats
        // these items rather than skipping the rest, and a repeat is something
        // SCAN can do anyway while a gap is not.
        cursor = previous;
        truncated = true;
        break;
      }
      cursor = next;

      rounds++;
      // A MATCH that hits nothing makes SCAN cheap but unbounded in rounds. Stop
      // after enough of them so an action answers instead of walking a huge
      // keyspace forever; the cursor is returned so a flow can continue.
      if (rounds >= 10_000) break;
    } while (cursor !== "0" && items.length < opts.max);

    return { items, cursor, done: cursor === "0" && !truncated };
  }

  /** Read INFO, parsed into one object per section. */
  async info(section: string): Promise<Record<string, Record<string, string>>> {
    const args: Arg[] = section !== "" && section.toLowerCase() !== "default" ? [section] : [];
    const raw = String(await this.send("INFO", args));
    return parseInfo(raw);
  }

  /** The server's version string, for the connection test. "" when unreadable. */
  async serverVersion(): Promise<string> {
    try {
      const info = await this.info("server");
      return info.server?.redis_version ?? "";
    } catch {
      return "";
    }
  }

  // watch keeps an `error` listener on every socket. ioredis emits errors as
  // events, and an EventEmitter with no `error` listener takes the process down
  // — so this is load-bearing, not logging. The throttle keeps a server that is
  // down from filling the log.
  private watch(conn: Redis): void {
    conn.on("error", (err: Error) => {
      const now = Date.now();
      if (now - this.lastErrorLoggedAt < 10_000) return;
      this.lastErrorLoggedAt = now;
      console.error(`redis plugin: connection ${this.connInfo}: ${err.message}`);
    });
  }
}

/**
 * parseInfo turns the INFO reply — `# Section` headings over `key:value` lines —
 * into one object per section, lower-cased section names.
 */
export function parseInfo(raw: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = "general";
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    if (text.startsWith("#")) {
      section = text.replace(/^#\s*/, "").trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const at = text.indexOf(":");
    if (at <= 0) continue;
    out[section] ??= {};
    out[section][text.slice(0, at)] = text.slice(at + 1);
  }
  return out;
}
