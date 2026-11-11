# Inflowenger Redis plugin

An Inflowenger **Plugin node** for [Redis](https://redis.io) (and Valkey). It
puts the Redis data types on the workflow canvas — strings and counters, hashes,
lists as queues, sets, sorted sets, streams, pub/sub — plus one action that runs
any Redis command. Built on
[`@inflowenger/node-plugin-sdk`](https://github.com/Inflowenger/node-plugin-sdk).

Runs on **any host** that speaks `inflowv1` — it reaches no host-specific
service.

The plugin holds **no** server credentials. It declares what a connection needs
(the settings form); the platform stores that as a named settings profile and
ships the values with every call as `body.settings`. One running plugin serves
many Redis servers, and rotating a password needs no redeploy.

## Actions

Each action is tagged with a `class` so the canvas groups them: `keys`, `hash`,
`list`, `set`, `sorted-set`, `stream`, `pubsub`, `server`.

| Method | Title | Does |
|--------|-------|------|
| `redis.key.get` | Get value | `GET` with the key's type and TTL; a key of another type names the action that reads it. |
| `redis.key.set` | Set value | `SET` with optional `EX` / `KEEPTTL` / `NX` / `XX` / `GET`. |
| `redis.key.delete` | Delete keys | `UNLINK` (or `DEL`) by name, or by glob — `SCAN`-based, capped, confirmed. |
| `redis.key.scan` | Scan keys | `SCAN` with `MATCH` / `TYPE` / `COUNT`, committing the cursor. |
| `redis.key.expire` | Set or clear expiry | `EXPIRE` / `EXPIREAT` / `PERSIST`, with the Redis 7 `NX`/`XX`/`GT`/`LT` conditions. |
| `redis.key.inspect` | Inspect keys | Per key: `EXISTS`, `TYPE`, `TTL`, size, `MEMORY USAGE`. |
| `redis.counter.increment` | Increment counter | `INCRBY` / `INCRBYFLOAT` / `HINCRBY`, with an expiry set only on first use. |
| `redis.hash.get` | Read hash | `HGETALL`, or `HMGET` for named fields. |
| `redis.hash.set` | Write hash fields | `HSET` (or `HSETNX`) from a JSON object, plus `HDEL` for fields to prune. |
| `redis.list.push` | Push to list | `RPUSH` / `LPUSH` (`…X` variants), with an optional `LTRIM` cap. |
| `redis.list.pop` | Pop from list | `LPOP` / `RPOP`, or `BLPOP` / `BRPOP` on a connection of its own. |
| `redis.list.range` | Read list range | `LRANGE` + `LLEN`. |
| `redis.set.add` | Add set members | `SADD`, reporting how many were new. |
| `redis.set.remove` | Remove set members | `SREM`. |
| `redis.set.members` | Read set members | `SSCAN` + `SCARD`, with an optional `SISMEMBER`. |
| `redis.zset.add` | Add scored members | `ZADD` with `NX`/`XX` and `GT`/`LT`. |
| `redis.zset.range` | Read sorted-set range | `ZRANGE` by rank or score, reversed, with scores. |
| `redis.stream.add` | Append to stream | `XADD`, with `MAXLEN ~` trimming. |
| `redis.stream.read` | Read from stream | `XRANGE` / `XREVRANGE`, `XREAD`, or `XREADGROUP` with `XGROUP CREATE … MKSTREAM` and optional `XACK`. |
| `redis.pubsub.publish` | Publish message | `PUBLISH`, with the receiver count. |
| `redis.command` | Run command | Any command, modules included. Refuses the ones that take over the connection. |
| `redis.server.info` | Server info | Parsed `INFO`, `DBSIZE`, and a summary. |

Meta RPCs: `redis.meta.ping.check` (**Test connection**) and
`redis.meta.key.pick` (the ↻ keyspace search behind every **Key** field).

## Values

**Writing** — a string goes as typed; a number or boolean is rendered; an object
or array is stored as JSON. So `{{$.order}}` in a value field writes the whole
upstream record.

**Reading** — the **Value decoding** field is `auto` (parse a plain JSON object
or array, leave everything else as text, so `007` stays `007`), `text` (never
parse) or `json` (insist).

Every string input is resolved against the flow scope first, so `{{$.path}}` and
`{{$this.id}}` work in keys, values, patterns, channels and members alike.

## What it will not do

- **No `KEYS`** — listing keys is always `SCAN` with a cursor and a cap.
- **No `SUBSCRIBE` / `PSUBSCRIBE` / `MONITOR`** — they take the connection out
  of request/reply mode, and an action is one request and one reply. They are
  refused with an explanation rather than hanging the node. Publish from here;
  read a stream when the messages have to survive.
- **No pattern delete** without the confirmation checkbox, and never for `*`.
- **No cluster yet** — a single server (primary or replica). A cluster answers
  `MOVED` for a key that lives on another node.

## Connection (settings profile)

| Key | Meaning |
|-----|---------|
| `url` | `redis://user:password@host:6379/0`, or `rediss://` for TLS. Wins over the fields below; they fill in what it omits. |
| `host` · `port` | Defaults `localhost` and `6379`. |
| `db` | Logical database index (`SELECT`). 0 unless you partition by index. |
| `username` · `password` | Redis 6+ ACL user, or a password-only server. |
| `tls` | Connect over TLS (implied by `rediss://`). |
| `tlsInsecure` | Accept a self-signed or mismatched certificate. Off by default. |

Keys are matched leniently — case, spaces, dashes and underscores are ignored,
and the usual synonyms are accepted (`uri`/`dsn` for `url`, `pass`/`secret` for
`password`, `dbIndex` for `db`, `ssl`/`secure` for `tls`), so a hand-typed
profile works too. A profile that is clearly for another plugin fails with the
keys it *did* contain.

One connection is pooled per distinct profile; no credential is ever logged or
stored by the plugin.

## Run

Provisioning is a prerequisite: the plugin must be defined in a space to get
`PLUGIN_ID`, `INFRA_CRED` (base64) and `INFRA_URL`. Put them in `.env.inflow`
(see `.env.inflow.example`) — **Redis credentials never go here**, they are a
settings profile.

```sh
cp .env.inflow.example .env.inflow   # PLUGIN_ID / INFRA_CRED / INFRA_URL
npm install
npm run build
npm start                            # node dist/main.js
```

During development, run the TypeScript directly:

```sh
npm run dev                          # tsx src/main.ts
```

The SDK logs each subscribed subject on startup — that line is how you tell
"registered" from "silently misconfigured". Add the node to a flow, bind a
settings profile, and run it.

**From FloMorphic:** define the plugin under **Extensions**, then either
download the filled-in `.env.inflow` and run the commands above, or run the
generated one-liner — it clones, starts, and injects `./plugin.sh` for
`start / stop / restart / status / logs / update`. See
[run-a-plugin.md](https://github.com/Inflowenger/plugin-catalog/blob/main/docs/run-a-plugin.md).

`REQ_TIMEOUT` (seconds) overrides the plugin's own 130s send deadline. Keep it
above the longest blocking pop or stream read a flow can ask for (the forms cap
that at 60s).

## Test

```sh
npm test                 # tsc + the offline suites (forms, settings, values)
```

The action suite runs the real handlers against a real server — only the `Job`
is faked — and is skipped unless you point it at one:

```sh
docker run -d --rm -p 6399:6379 redis:7-alpine
REDIS_TEST_URL=redis://localhost:6399/9 npm test
```

It works inside its own key prefix and deletes it afterwards, but it does write:
point it at a scratch database, never a live one.

## Layout

```
src/main.ts              wiring: intro, settings, actions, meta, start
src/actions/forms.ts     every form, declared with formkit
src/actions/registry.ts  the pool, the job runner, the two meta RPCs
src/actions/keys.ts      ┐
src/actions/hash.ts      │
src/actions/lists.ts     ├ one file per group of actions
src/actions/sets.ts      │
src/actions/streams.ts   │
src/actions/server.ts    ┘
src/actions/kit.ts       input readers shared by the groups
src/actions/vars.ts      {{$.path}} resolution against the flow scope
src/redis/settings.ts    settings profile → Config, and the connection pool
src/redis/client.ts      one connection: send / batch / scan / blocking send
src/redis/value.ts       value encoding, decoding, and the input parsers
```

`src/redis/` imports nothing from the SDK, so the Redis side is testable without
NATS.

## Requirements

Node 20+, Redis 6+ or Valkey. A few options need a newer server and say so in the
field's own description: the `EXPIRE` conditions are Redis 7+, and `ZRANGE` by
score or reversed is 6.2+.
