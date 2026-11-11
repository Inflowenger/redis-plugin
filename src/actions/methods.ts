// Every method name this plugin serves, in one place. A method is the wire
// contract — renaming one breaks every saved node that uses it — so they are
// named here once and referenced from the form, the action and the picker.

export const M = {
  // keys and counters
  keyGet: "redis.key.get",
  keySet: "redis.key.set",
  keyDelete: "redis.key.delete",
  keyScan: "redis.key.scan",
  keyExpire: "redis.key.expire",
  keyInspect: "redis.key.inspect",
  counterIncrement: "redis.counter.increment",

  // hashes
  hashGet: "redis.hash.get",
  hashSet: "redis.hash.set",

  // lists
  listPush: "redis.list.push",
  listPop: "redis.list.pop",
  listRange: "redis.list.range",

  // sets
  setAdd: "redis.set.add",
  setRemove: "redis.set.remove",
  setMembers: "redis.set.members",

  // sorted sets
  zsetAdd: "redis.zset.add",
  zsetRange: "redis.zset.range",

  // streams
  streamAdd: "redis.stream.add",
  streamRead: "redis.stream.read",

  // pub/sub
  publish: "redis.pubsub.publish",

  // server
  command: "redis.command",
  serverInfo: "redis.server.info",

  // meta RPCs
  metaPing: "redis.meta.ping.check",
  metaKeyPick: "redis.meta.key.pick",
} as const;

/** The `class` tag that groups an action in the node palette. */
export const CLASS = {
  keys: "keys",
  hash: "hash",
  list: "list",
  set: "set",
  zset: "sorted-set",
  stream: "stream",
  pubsub: "pubsub",
  server: "server",
} as const;
