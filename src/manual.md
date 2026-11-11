# Redis

Keys, hashes, lists, sets, sorted sets, streams and pub/sub on the Inflowenger
canvas — plus one action that runs any Redis command. This node holds **no**
server credentials: a connection travels with every call as a settings profile
(`body.settings`), so one running plugin serves many Redis servers and rotating
a password needs no redeploy.

Works with Redis 6+ and with Valkey. A few options need a newer server, and say
so where they appear.

## Actions

### Keys and counters

| Method | Title | What it does |
| --- | --- | --- |
| `redis.key.get` | Get value | Reads a string key, with its type and remaining TTL. A key of another type is reported with the action that reads it. |
| `redis.key.set` | Set value | Writes a string, optionally with an expiry, an only-if-missing / only-if-present condition, and the previous value returned. |
| `redis.key.delete` | Delete keys | Deletes named keys, or every key matching a glob — the pattern form walks the keyspace with `SCAN`, is capped, and must be confirmed. |
| `redis.key.scan` | Scan keys | Lists keys with `SCAN` (never `KEYS`) and commits the cursor, so a flow can page through a large keyspace. |
| `redis.key.expire` | Set or clear expiry | `EXPIRE`, `EXPIREAT` or `PERSIST`. |
| `redis.key.inspect` | Inspect keys | Per key: exists, type, TTL, size and memory usage. |
| `redis.counter.increment` | Increment counter | `INCRBY` / `HINCRBY`, whole or fractional, with an expiry applied **only on first use** — a rate-limit window that does not reset on every hit. |

### Hashes, lists, sets, sorted sets

| Method | Title | What it does |
| --- | --- | --- |
| `redis.hash.get` | Read hash | The whole hash (`HGETALL`) or named fields (`HMGET`), as an object. |
| `redis.hash.set` | Write hash fields | Writes fields from a JSON object, optionally only the missing ones, and removes other fields in the same call. |
| `redis.list.push` | Push to list | `RPUSH` / `LPUSH`, optionally capping the list so a log cannot grow without bound. |
| `redis.list.pop` | Pop from list | `LPOP` / `RPOP`, or **waits** for an item (`BLPOP` / `BRPOP`) on a connection of its own. |
| `redis.list.range` | Read list range | `LRANGE` plus the list's length, removing nothing. |
| `redis.set.add` · `redis.set.remove` · `redis.set.members` | Sets | `SADD` / `SREM` / `SSCAN` + `SCARD`, with an optional membership test. |
| `redis.zset.add` | Add scored members | `ZADD`, with NX/XX and the GT/LT score conditions — a high-water mark with no read first. |
| `redis.zset.range` | Read sorted-set range | Top-N by rank or a score window, with scores (needs Redis 6.2+ for score windows and reversed order). |

### Streams, pub/sub, server

| Method | Title | What it does |
| --- | --- | --- |
| `redis.stream.add` | Append to stream | `XADD`, optionally trimming with `MAXLEN ~`. |
| `redis.stream.read` | Read from stream | A historical range, only what is new since an id, or a consumer group's next batch — the group is created on first use. |
| `redis.pubsub.publish` | Publish message | `PUBLISH`, reporting how many subscribers received it. |
| `redis.command` | Run command | Any command, modules included (`JSON.SET`, `FT.SEARCH`, `TS.ADD`). |
| `redis.server.info` | Server info | Parsed `INFO`, the database's key count, and a summary — version, mode, role, clients, memory, hit rate. |

## Values

Writing: a string goes as typed; a number or a boolean is rendered; an **object
or array is stored as JSON**. So an upstream record can be written with a single
token — `{{$.order}}` in a value field, or in a hash's **Fields** box.

Reading: **Auto** (the default) parses a value that is plainly a JSON object or
array and leaves everything else as text, so `007` stays `007`. **Text** never
parses; **JSON** insists and fails otherwise.

## `{{$.path}}` — pull values from the flow

Every string input — a key, a value, a channel, a member, a pattern — is
resolved against the flow scope before the command runs. `{{$this.id}}` is the
location this run was handed, which beats a hardcoded index when the node's
scope selects more than one. A token the scope cannot supply is left verbatim.

## A queue between two flows

`redis.list.push` on one side, `redis.list.pop` with **Wait for an item** on the
other. The waiting pop runs on its own connection, so it never holds up anything
else, and an empty list is a *successful* run with no values — route on
`empty` rather than treating it as a failure. For work that must survive a
crash, use a stream with a consumer group and leave **Acknowledge** off until
the work is done.

## What this node will not do

- **No `KEYS`.** Listing keys is always `SCAN` with a cursor and a cap.
- **No subscribing.** `SUBSCRIBE`, `PSUBSCRIBE` and `MONITOR` take over the
  connection; an action is one request and one reply, so they are refused rather
  than left hanging. Publish from here and subscribe in the service that needs
  the stream of messages — or read a Redis stream, which is durable.
- **No pattern delete without a confirmation**, and never for `*`.

## Connection

The set-up form takes either a URL — `redis://user:password@host:6379/0`, or
`rediss://` for TLS — **or** the discrete host / port / database / username /
password / TLS fields. A URL wins, and the fields fill in what it leaves out.
Press **Test connection** (↻) to check them against the live server before
saving.

Every **Key** field has a ↻ button that searches the keyspace: press it with the
box empty to list keys, or type part of a name to match `<name>*`.

```inflow-meta
redis.meta.ping.check
```

## Notes

- One connection is pooled per distinct profile, so many nodes on the same
  profile share one socket.
- Redis Cluster is not supported yet (a single server, primary or replica, is).
  A cluster's single-key commands work against one node, but a key that hashes
  elsewhere answers `MOVED`.
- A blocking pop or stream read may wait up to 60s. The plugin's own deadline is
  130s; if you deploy with a different `REQ_TIMEOUT`, keep it above the longest
  wait a flow can ask for.
