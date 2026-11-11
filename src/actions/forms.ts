// Every form this plugin serves, declared with the SDK's formkit builder, which
// generates the JSON Schema and the JSON Forms UI Schema from one statement per
// field. A malformed form throws at start-up (build calls validate), where it is
// a programming mistake rather than a dialog that will not open.
//
// Nothing here may ask for a connection: no host, no password, no database
// index. Those live on the settings profile and arrive as body.settings.

import { formkit, type FormBuilder } from "@inflowenger/node-plugin-sdk";

import { M } from "./methods.js";

// ------------------------------------------------------------- shared text --

const tokenNote = "Accepts {{$.path}} tokens, which are resolved against the flow before the command runs.";

const descDecode =
  'How a value read back is decoded. "Auto" parses a value that is plainly a JSON object or array and leaves everything else as text, so a zero-padded code stays text. "JSON" insists on JSON and fails otherwise. "Text" never parses.';

const decodeChoices = [
  { value: "auto", label: "Auto — parse JSON objects and arrays" },
  { value: "text", label: "Text — never parse" },
  { value: "json", label: "JSON — require JSON" },
];

// ------------------------------------------------------------ field makers --

// A key field with the keyspace picker behind its ↻ button. `method` is the
// action the picker rebuilds when the pattern matches more than one key, which
// is how one meta RPC serves every form in the plugin.
function keyField(method: string, title = "Key", note = ""): formkit.Field {
  return formkit
    .text("key", title)
    .required()
    .describe(
      `${note === "" ? "" : note + " "}Press ↻ to search the keyspace: with the box empty it lists keys, and a partial name is matched as <name>*. ${tokenNote}`,
    )
    .lookup(M.metaKeyPick, "Find key")
    .picks(method);
}

function decodeField(): formkit.Field {
  return formkit.choice("decode", "Value decoding", ...decodeChoices).default("auto").describe(descDecode);
}

function ttlField(note = ""): formkit.Field {
  return formkit
    .integer("ttlSeconds", "Expire after (seconds)")
    .default(0)
    .min(0)
    .describe(`0 leaves the key's own expiry untouched. Above 0 sets it after the write. ${note}`.trim());
}

// ---------------------------------------------------------------- settings --

/**
 * The settings profile the platform stores and ships with every call as
 * body.settings. A full URL or the discrete fields — either works; a URL, when
 * given, wins, and the fields fill in what it leaves out.
 */
export const settingsForm = formkit
  .form("Redis connection")
  .describe(
    "Stored by the platform as a reusable settings profile and shipped with every call as body.settings. The plugin keeps nothing. Give a connection URL, or fill in the fields below.",
  )
  .submitTo(M.metaPing)
  .add(
    formkit
      .text("url", "Connection URL")
      .describe(
        "redis://host:6379/0 — or rediss:// for TLS. A URL may carry the user, password and database index (redis://default:secret@cache.internal:6379/2). Given, it wins; leave it empty to use the fields below.",
      ),
    formkit.text("host", "Host").describe("e.g. localhost or cache.internal.").default("localhost"),
    formkit.integer("port", "Port").default(6379).describe("Defaults to 6379."),
    formkit
      .integer("db", "Database index")
      .default(0)
      .min(0)
      .describe(
        "The logical database every command runs against (Redis SELECT). 0 unless you deliberately partition by index — note that Redis Cluster supports index 0 only.",
      ),
    formkit
      .text("username", "Username (ACL)")
      .describe("Redis 6+ ACL user. Leave empty for a server that authenticates with a password only."),
    formkit.secret("password", "Password").describe("The AUTH password (requirepass), or the ACL user's password."),
    formkit
      .bool("tls", "TLS")
      .default(false)
      .describe("Connect over TLS. Implied by a rediss:// URL."),
    formkit
      .bool("tlsInsecure", "Skip TLS certificate verification")
      .default(false)
      .describe(
        "Accept a self-signed or mismatched certificate. Leave off unless you know why you are turning it on — it removes the protection TLS was added for.",
      ),
    // The button hangs off the last field and its answer appears under it, so a
    // bad connection is reported while it is being entered rather than by every
    // node that later fails. It writes no value — saying what it found is the
    // whole point.
    formkit
      .text("test", "Test connection")
      .describe("Press ↻ to PING these values against the live server before saving.")
      .lookup(M.metaPing, "Test connection"),
  )
  .build();

// ------------------------------------------------------------------- keys --

export const keyGetForm = formkit
  .form("Get value")
  .describe("Read a string key, with its type and remaining time to live.")
  .add(keyField(M.keyGet), decodeField())
  .build();

export const keySetForm = formkit
  .form("Set value")
  .describe("Write a string key, optionally with an expiry and only-if-missing / only-if-present conditions.")
  .add(
    keyField(M.keySet),
    formkit
      .textArea("value", "Value")
      .required()
      .describe(
        `The value to store. A JSON object or array can be pasted whole. ${tokenNote} To write an upstream record as JSON, use a single token: {{$.order}}.`,
      ),
    ttlField("Redis sets it atomically with the value (SET … EX)."),
    formkit
      .choice(
        "mode",
        "Condition",
        { value: "", label: "Always write" },
        { value: "NX", label: "Only if the key does not exist (NX)" },
        { value: "XX", label: "Only if the key already exists (XX)" },
      )
      .default("")
      .describe(
        'A condition the server checks atomically. With NX or XX the output\'s "written" says whether the write happened — the action does not fail when the condition was not met.',
      ),
    formkit
      .bool("keepTtl", "Keep the existing expiry")
      .default(false)
      .describe("SET … KEEPTTL: leave the key's current expiry in place instead of clearing it. Cannot be combined with an expiry above."),
    formkit
      .bool("returnOld", "Return the previous value")
      .default(false)
      .describe("SET … GET: commit the value the key held before this write, as `previous`."),
  )
  .build();

export const keyDeleteForm = formkit
  .form("Delete keys")
  .describe(
    "Delete keys by name, or every key matching a pattern. Deleting by pattern walks the keyspace with SCAN — never KEYS — and has to be confirmed.",
  )
  .add(
    formkit
      .list("keys", "Keys")
      .describe(`The keys to delete. Missing keys are not an error. ${tokenNote}`),
    formkit
      .text("pattern", "Pattern")
      .describe(
        'Optional glob to delete by, e.g. session:* or cache:user:42:*. Requires the confirmation below. "*" on its own is refused — use FLUSHDB through the raw command action if that is really what you mean.',
      ),
    formkit
      .bool("confirmPattern", "I mean it: delete every key matching the pattern")
      .default(false)
      .describe("A pattern delete is irreversible and unbounded in blast radius, so it runs only when this is on."),
    formkit
      .integer("maxKeys", "Most keys to delete")
      .default(1000)
      .between(1, 100000)
      .describe("Ceiling on a pattern delete. When it is reached the action stops and reports `truncated`, so you can run it again."),
    formkit
      .bool("unlink", "Delete in the background (UNLINK)")
      .default(true)
      .describe("UNLINK reclaims memory in a background thread instead of blocking the server, which matters for a large collection. Turn it off for plain DEL."),
  )
  .build();

export const keyScanForm = formkit
  .form("Scan keys")
  .describe("Walk the keyspace with SCAN and return the matching keys — the safe way to list keys on a live server.")
  .add(
    formkit
      .text("pattern", "Pattern")
      .default("*")
      .describe(`Glob to match, e.g. user:*:profile. ${tokenNote}`),
    formkit
      .choice(
        "type",
        "Only this type",
        { value: "", label: "Any type" },
        { value: "string", label: "string" },
        { value: "list", label: "list" },
        { value: "set", label: "set" },
        { value: "zset", label: "sorted set" },
        { value: "hash", label: "hash" },
        { value: "stream", label: "stream" },
      )
      .default("")
      .describe("SCAN … TYPE: filter server-side (Redis 6+)."),
    formkit
      .integer("maxKeys", "Most keys to return")
      .default(1000)
      .between(1, 100000)
      .describe("The scan stops here and commits the cursor it reached, so a flow can continue from it."),
    formkit
      .text("cursor", "Start from cursor")
      .default("0")
      .describe('Continue a previous scan by passing the `cursor` it committed. "0" starts from the beginning.'),
  )
  .build();

export const keyExpireForm = formkit
  .form("Set or clear expiry")
  .describe("Give a key a time to live, expire it at a wall-clock moment, or make it permanent.")
  .add(
    keyField(M.keyExpire),
    formkit
      .choice(
        "mode",
        "What to do",
        { value: "seconds", label: "Expire after N seconds (EXPIRE)" },
        { value: "at", label: "Expire at a Unix timestamp (EXPIREAT)" },
        { value: "persist", label: "Remove the expiry (PERSIST)" },
      )
      .default("seconds"),
    formkit
      .integer("ttlSeconds", "Seconds")
      .default(60)
      .min(1)
      .describe("Used by the seconds mode.")
      .showWhen("mode", "seconds"),
    formkit
      .integer("atUnix", "Unix timestamp (seconds)")
      .default(0)
      .min(0)
      .describe("Used by the timestamp mode. Seconds since the epoch, UTC.")
      .showWhen("mode", "at"),
    formkit
      .choice(
        "condition",
        "Only when",
        { value: "", label: "Always" },
        { value: "NX", label: "The key has no expiry (NX)" },
        { value: "XX", label: "The key already has one (XX)" },
        { value: "GT", label: "The new expiry is later (GT)" },
        { value: "LT", label: "The new expiry is earlier (LT)" },
      )
      .default("")
      .describe("Redis 7+ only. A server older than that rejects the command when this is set — leave it on Always there.")
      .hideWhen("mode", "persist"),
  )
  .build();

export const keyInspectForm = formkit
  .form("Inspect keys")
  .describe("Report what each key is: whether it exists, its type, its time to live, its size and how much memory it uses.")
  .add(
    formkit
      .list("keys", "Keys")
      .describe(`One or more keys to look at. ${tokenNote}`),
    formkit
      .bool("memory", "Include memory usage")
      .default(true)
      .describe("MEMORY USAGE walks the value, so it costs more on a large collection. Servers that disable the command simply report null."),
  )
  .build();

export const counterIncrementForm = formkit
  .form("Increment counter")
  .describe("Add to a counter atomically — the whole point of keeping one in Redis. Works on a key, or on one field of a hash.")
  .add(
    keyField(M.counterIncrement),
    formkit
      .text("field", "Hash field")
      .describe("Leave empty to increment the key itself (INCRBY). Set it to increment one field of a hash (HINCRBY)."),
    formkit
      .number("by", "Increment by")
      .default(1)
      .describe("May be negative to count down, and fractional — a non-whole step uses INCRBYFLOAT / HINCRBYFLOAT."),
    formkit
      .integer("ttlSeconds", "Expire after (seconds)")
      .default(0)
      .min(0)
      .describe(
        "0 leaves the expiry alone. Above 0 it is applied only when the key has none yet, which is how a rate-limit window is kept without resetting on every hit.",
      ),
  )
  .build();

// ----------------------------------------------------------------- hashes --

export const hashGetForm = formkit
  .form("Read hash")
  .describe("Read a hash as an object — every field, or only the ones you name.")
  .add(
    keyField(M.hashGet),
    formkit
      .list("fields", "Fields")
      .describe("Leave empty for the whole hash (HGETALL). Naming fields reads only those (HMGET)."),
    decodeField(),
  )
  .build();

export const hashSetForm = formkit
  .form("Write hash fields")
  .describe("Write fields into a hash from a JSON object, and optionally remove others in the same call.")
  .add(
    keyField(M.hashSet),
    formkit
      .textArea("fields", "Fields (JSON object)")
      .describe(
        `A JSON object of field → value, e.g. {"status":"shipped","items":3}. A nested object or array is stored as JSON. ${tokenNote} A whole upstream record can be written with one token: {{$.order}}.`,
      ),
    formkit
      .list("removeFields", "Fields to remove")
      .describe("Optional HDEL, applied after the write — so one node can both update and prune a record."),
    formkit
      .bool("onlyIfMissing", "Only write fields that do not exist yet")
      .default(false)
      .describe("HSETNX per field: existing fields are left as they are, and the output lists which fields were skipped."),
    ttlField("Applied to the hash key as a whole."),
  )
  .build();

// ------------------------------------------------------------------ lists --

export const listPushForm = formkit
  .form("Push to list")
  .describe("Append items to a list — the producer half of a Redis queue — optionally capping its length.")
  .add(
    keyField(M.listPush),
    formkit
      .list("values", "Values")
      .describe(`The items to push, in order. A JSON object or array is stored as JSON. ${tokenNote}`),
    formkit
      .choice(
        "side",
        "Push to",
        { value: "right", label: "The tail (RPUSH) — FIFO with a left pop" },
        { value: "left", label: "The head (LPUSH) — LIFO with a left pop" },
      )
      .default("right"),
    formkit
      .integer("maxLength", "Cap the list at")
      .default(0)
      .min(0)
      .describe("0 means no cap. Above 0 the list is trimmed to this many items after the push, keeping the ones nearest the end you pushed to — how a capped log or recent-items list is kept."),
    formkit
      .bool("onlyIfExists", "Only if the list already exists")
      .default(false)
      .describe("RPUSHX / LPUSHX: do not create the list. Useful when a consumer is supposed to have created it."),
    ttlField(),
  )
  .build();

export const listPopForm = formkit
  .form("Pop from list")
  .describe("Take items off a list — the consumer half of a Redis queue — waiting for one to arrive if you ask it to.")
  .add(
    keyField(M.listPop),
    formkit
      .choice(
        "side",
        "Pop from",
        { value: "left", label: "The head (LPOP)" },
        { value: "right", label: "The tail (RPOP)" },
      )
      .default("left"),
    formkit
      .integer("count", "How many")
      .default(1)
      .between(1, 10000)
      .describe("Pops up to this many items in one call (Redis 6.2+ for more than one). Ignored while waiting is on, which pops exactly one."),
    formkit
      .integer("blockSeconds", "Wait for an item (seconds)")
      .default(0)
      .between(0, 60)
      .describe(
        "0 returns immediately, empty-handed if the list is empty. Above 0 the command waits on a connection of its own (BLPOP / BRPOP) — keep it below the node's own timeout, and remember the plugin's REQ_TIMEOUT has to be larger still.",
      ),
    decodeField(),
  )
  .build();

export const listRangeForm = formkit
  .form("Read list range")
  .describe("Read a slice of a list without removing anything, plus its total length.")
  .add(
    keyField(M.listRange),
    formkit
      .integer("start", "From index")
      .default(0)
      .describe("0 is the head. Negative counts from the tail: -1 is the last item."),
    formkit
      .integer("stop", "To index (inclusive)")
      .default(-1)
      .describe("-1 means the end of the list. LRANGE is inclusive at both ends."),
    decodeField(),
  )
  .build();

// ------------------------------------------------------------------- sets --

export const setAddForm = formkit
  .form("Add set members")
  .describe("Add members to a set. Adding one that is already there is not an error — it just does nothing.")
  .add(
    keyField(M.setAdd),
    formkit.list("members", "Members").describe(`The members to add. ${tokenNote}`),
    ttlField(),
  )
  .build();

export const setRemoveForm = formkit
  .form("Remove set members")
  .describe("Remove members from a set. Members that are not there are ignored.")
  .add(keyField(M.setRemove), formkit.list("members", "Members").describe(`The members to remove. ${tokenNote}`))
  .build();

export const setMembersForm = formkit
  .form("Read set members")
  .describe("Read a set's members and its size, and optionally test one membership.")
  .add(
    keyField(M.setMembers),
    formkit
      .text("member", "Check this member")
      .describe("Optional. When set, the output also carries `contains` for it (SISMEMBER)."),
    formkit
      .integer("maxMembers", "Most members to return")
      .default(1000)
      .between(1, 100000)
      .describe("The set is walked with SSCAN, so a large one is paged rather than pulled in one reply. `size` always reports the true cardinality."),
    decodeField(),
  )
  .build();

// ----------------------------------------------------------- sorted sets --

export const zsetAddForm = formkit
  .form("Add scored members")
  .describe("Add or update members of a sorted set — a leaderboard, a priority queue, or anything kept in score order.")
  .add(
    keyField(M.zsetAdd),
    formkit
      .textArea("members", "Members (JSON)")
      .describe(
        `Either an object of member → score, {"alice":12,"bob":7.5}, or an array of entries, [{"member":"alice","score":12}]. ${tokenNote}`,
      ),
    formkit
      .choice(
        "mode",
        "Condition",
        { value: "", label: "Add and update" },
        { value: "NX", label: "Only add new members (NX)" },
        { value: "XX", label: "Only update existing members (XX)" },
      )
      .default(""),
    formkit
      .choice(
        "update",
        "Update the score only when",
        { value: "", label: "Always" },
        { value: "GT", label: "The new score is greater (GT)" },
        { value: "LT", label: "The new score is lower (LT)" },
      )
      .default("")
      .describe("Redis 6.2+. Keeps a high-water mark without a read-modify-write."),
    ttlField(),
  )
  .build();

export const zsetRangeForm = formkit
  .form("Read sorted-set range")
  .describe("Read members in score order — top N, a score window, or a rank slice — with their scores.")
  .add(
    keyField(M.zsetRange),
    formkit
      .choice(
        "by",
        "Select by",
        { value: "rank", label: "Rank — position in the order" },
        { value: "score", label: "Score — a value window" },
      )
      .default("rank"),
    formkit
      .text("min", "From")
      .default("0")
      .describe(
        'By rank: the first position, 0-based (negative counts from the end). By score: the low bound — a number, "-inf", or "(5" to exclude 5 itself.',
      ),
    formkit
      .text("max", "To (inclusive)")
      .default("-1")
      .describe('By rank: the last position, -1 for the end. By score: the high bound — a number, "+inf", or "(10".'),
    formkit
      .bool("reverse", "Highest score first")
      .default(false)
      .describe("Reverses the order, so this plus rank 0…9 is a top-ten leaderboard."),
    formkit.bool("withScores", "Include scores").default(true),
    formkit
      .integer("limit", "Most entries to return")
      .default(100)
      .between(1, 10000)
      .describe("Applied by the server when selecting by score, and by trimming when selecting by rank."),
  )
  .build();

// ---------------------------------------------------------------- streams --

export const streamAddForm = formkit
  .form("Append to stream")
  .describe("Append an entry to a stream — an append-only log a consumer group can read at its own pace.")
  .add(
    keyField(M.streamAdd, "Stream"),
    formkit
      .textArea("fields", "Entry (JSON object)")
      .describe(
        `A JSON object of field → value, e.g. {"event":"order.paid","orderId":"A-17"}. A nested value is stored as JSON. ${tokenNote}`,
      ),
    formkit
      .text("id", "Entry ID")
      .default("*")
      .describe('"*" lets the server assign the id, which is almost always right. An explicit id must be greater than the stream\'s last one.'),
    formkit
      .integer("maxLength", "Cap the stream at")
      .default(0)
      .min(0)
      .describe("0 means no cap. Above 0 the stream is trimmed with MAXLEN ~ (approximate, the cheap form) after the append."),
    ttlField("Applied to the stream key as a whole."),
  )
  .build();

export const streamReadForm = formkit
  .form("Read from stream")
  .describe("Read stream entries: a historical range, only what is new, or the next batch for a consumer group.")
  .add(
    keyField(M.streamRead, "Stream"),
    formkit
      .choice(
        "mode",
        "How to read",
        { value: "range", label: "Range — entries between two ids (XRANGE)" },
        { value: "new", label: "New entries since an id, waiting for them (XREAD)" },
        { value: "group", label: "Consumer group — the next unread batch (XREADGROUP)" },
      )
      .default("range"),
    formkit
      .integer("count", "Most entries")
      .default(10)
      .between(1, 10000),
    formkit
      .text("start", "From id")
      .default("-")
      .describe('Range mode. "-" is the first entry; an id like 1700000000000-0 starts there; "(1700000000000-0" excludes it.')
      .showWhen("mode", "range"),
    formkit
      .text("end", "To id")
      .default("+")
      .describe('Range mode. "+" is the last entry.')
      .showWhen("mode", "range"),
    formkit
      .bool("reverse", "Newest first")
      .default(false)
      .describe("Range mode: read backwards (XREVRANGE), so count = 1 gives the latest entry.")
      .showWhen("mode", "range"),
    formkit
      .text("lastId", "After id")
      .default("$")
      .describe('New-entries mode. "$" means only entries added from now on — pair it with a wait below. Otherwise pass the `lastId` a previous run committed to carry on where it stopped.')
      .showWhen("mode", "new"),
    formkit
      .text("group", "Group")
      .describe("Consumer-group mode: the group's name.")
      .showWhen("mode", "group"),
    formkit
      .text("consumer", "Consumer")
      .default("inflow")
      .describe("Consumer-group mode: the name this reader claims entries under. Give each parallel reader its own.")
      .showWhen("mode", "group"),
    formkit
      .bool("createGroup", "Create the group if it is missing")
      .default(true)
      .describe("XGROUP CREATE … MKSTREAM, starting at the end of the stream, so a flow works on first run.")
      .showWhen("mode", "group"),
    formkit
      .bool("ack", "Acknowledge what was read")
      .default(false)
      .describe(
        "XACK each entry straight away. Off (the default) leaves the batch pending, so a crashed flow can have it redelivered — acknowledge it later with the raw command action once the work is done.",
      )
      .showWhen("mode", "group"),
    formkit
      .integer("blockSeconds", "Wait for entries (seconds)")
      .default(0)
      .between(0, 60)
      .describe(
        "New-entries and consumer-group modes. 0 returns immediately. Above 0 the command waits on a connection of its own — keep it below the node's timeout, and the plugin's REQ_TIMEOUT above it.",
      )
      .hideWhen("mode", "range"),
    decodeField(),
  )
  .build();

// ----------------------------------------------------------------- pub/sub --

export const publishForm = formkit
  .form("Publish message")
  .describe("Publish a message to a channel. Redis pub/sub is fire-and-forget: a message with no subscriber is dropped.")
  .add(
    formkit
      .text("channel", "Channel")
      .required()
      .describe(`The channel to publish on, e.g. events:orders. ${tokenNote}`),
    formkit
      .textArea("message", "Message")
      .required()
      .describe(`The payload. A JSON object or array is sent as JSON. ${tokenNote}`),
  )
  .build();

// ------------------------------------------------------------------ server --

export const commandForm = formkit
  .form("Run command")
  .describe(
    "Run any Redis command — the escape hatch for what the typed actions do not cover (SETRANGE, GEOADD, FT.SEARCH, JSON.SET, SCRIPT, CLUSTER …).",
  )
  .add(
    formkit
      .text("command", "Command")
      .required()
      .describe(
        `The command, optionally with its arguments on the same line: GETRANGE page:1 0 99. Quotes group an argument that contains spaces. ${tokenNote}`,
      )
      .help(
        "Values are sent as arguments, never spliced into a command string — so a value can never turn into a command. Commands that take over the connection (SUBSCRIBE, MONITOR) are refused, because an action is one request and one reply.",
      ),
    formkit
      .list("args", "Extra arguments")
      .describe("Appended after anything on the command line above, one argument per row — the right place for a value with spaces, or one that comes from a {{$.path}} token."),
    decodeField(),
    formkit
      .integer("blockSeconds", "Wait (seconds)")
      .default(0)
      .between(0, 60)
      .describe("Only for the blocking commands (BLPOP, BZPOPMIN, XREAD …): they run on a connection of their own, and this is the backstop if the server never answers."),
  )
  .build();

export const serverInfoForm = formkit
  .form("Server info")
  .describe("Read the server's INFO, the key count of the connected database, and a short summary of the headline numbers.")
  .add(
    formkit
      .choice(
        "section",
        "Section",
        { value: "default", label: "Default — the usual sections" },
        { value: "all", label: "Everything" },
        { value: "server", label: "server" },
        { value: "clients", label: "clients" },
        { value: "memory", label: "memory" },
        { value: "persistence", label: "persistence" },
        { value: "stats", label: "stats" },
        { value: "replication", label: "replication" },
        { value: "keyspace", label: "keyspace" },
        { value: "commandstats", label: "commandstats" },
      )
      .default("default")
      .describe("Which INFO section to read. The whole reply is committed, parsed into one object per section."),
  )
  .build();

// -------------------------------------------------------------- by method --

/**
 * Every action's form by method name. The keyspace picker needs it: when a
 * search matches several keys it rebuilds the open dialog with the key field as
 * a drop-down, and the host tells it which form that is (formkit's `.picks()`
 * posts the method under `form`).
 */
export const formsByMethod: Record<string, FormBuilder> = {
  [M.keyGet]: keyGetForm,
  [M.keySet]: keySetForm,
  [M.keyExpire]: keyExpireForm,
  [M.counterIncrement]: counterIncrementForm,
  [M.hashGet]: hashGetForm,
  [M.hashSet]: hashSetForm,
  [M.listPush]: listPushForm,
  [M.listPop]: listPopForm,
  [M.listRange]: listRangeForm,
  [M.setAdd]: setAddForm,
  [M.setRemove]: setRemoveForm,
  [M.setMembers]: setMembersForm,
  [M.zsetAdd]: zsetAddForm,
  [M.zsetRange]: zsetRangeForm,
  [M.streamAdd]: streamAddForm,
  [M.streamRead]: streamReadForm,
};

/** Every form the plugin serves, for the test that walks them all. */
export const allForms: Record<string, FormBuilder> = {
  settings: settingsForm,
  ...formsByMethod,
  [M.keyDelete]: keyDeleteForm,
  [M.keyScan]: keyScanForm,
  [M.keyInspect]: keyInspectForm,
  [M.publish]: publishForm,
  [M.command]: commandForm,
  [M.serverInfo]: serverInfoForm,
};
