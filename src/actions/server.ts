// The two server-level actions: the raw command escape hatch, and INFO.
//
// The escape hatch is deliberate — Redis has hundreds of commands and modules
// add hundreds more (JSON.SET, FT.SEARCH, TS.ADD), so there has to be one action
// that reaches what the typed ones do not model. It is still one request and one
// reply, which is why the commands that take over the connection are refused
// rather than quietly hung.

import type { Action } from "@inflowenger/node-plugin-sdk";

import { isBlocking, isUnsupported, type Arg } from "../redis/client.js";
import { asNumber, decodeMode, decodeValue, splitCommandLine } from "../redis/value.js";
import { capped, int, preview, raw as rawText, requireStr, str, type Kit, type Output } from "./kit.js";
import { commandForm, serverInfoForm } from "./forms.js";
import { CLASS, M } from "./methods.js";

const blockGraceMs = 5_000;

export function serverActions(kit: Kit): Action[] {
  return [
    {
      method: M.command,
      title: "Run command",
      description:
        "Run any Redis command — including a module's (JSON.SET, FT.SEARCH, TS.ADD) — and commit its reply. Arguments are sent as arguments, never spliced into a command string. Commands that take over the connection (SUBSCRIBE, MONITOR) are refused.",
      icon: { icon: "mdi-console" },
      tags: { class: CLASS.server },
      form: commandForm,
      requestHandler: kit.run("command", async (job, client, input) => {
        const line = requireStr(input.command, "command");
        const mode = decodeMode(input.decode);
        const blockSeconds = capped(int(input.blockSeconds, 0, "blockSeconds"), 60);

        const parts = splitCommandLine(line);
        if (parts.length === 0) throw new Error("missing required input: command");

        const command = parts[0];
        const args: Arg[] = [...parts.slice(1), ...extraArgs(input.args)];

        if (isUnsupported(command)) {
          throw new Error(
            `${command.toUpperCase()} cannot be run from a node: it takes the connection out of request/reply mode, and an action is one request and one reply`,
          );
        }

        await job.progress(50, { title: command.toUpperCase(), content: preview(args.map(String).join(" "), 70) });

        const reply =
          blockSeconds > 0 || isBlocking(command)
            ? await client.sendBlocking(command, args, (blockSeconds > 0 ? blockSeconds : 30) * 1000 + blockGraceMs)
            : await client.send(command, args);

        return {
          command: command.toUpperCase(),
          args: args.map(String),
          reply: decodeValue(reply, mode),
        };
      }),
    },

    {
      method: M.serverInfo,
      title: "Server info",
      description:
        "Read the server's INFO parsed into one object per section, the connected database's key count, and a short summary — version, mode, role, uptime, clients, memory and hit rate.",
      icon: { icon: "mdi-server" },
      tags: { class: CLASS.server },
      form: serverInfoForm,
      requestHandler: kit.run("info", async (job, client, input) => {
        const section = str(input.section) || "default";

        await job.progress(50, { title: "info", content: `${section} on ${client.connInfo}` });

        const info = await client.info(section);
        const dbSize = asNumber(await client.send("DBSIZE", []));

        // The summary is read from whichever sections the chosen INFO carried,
        // so a narrow section simply leaves its fields out.
        const server = info.server ?? {};
        const clients = info.clients ?? {};
        const memory = info.memory ?? {};
        const stats = info.stats ?? {};
        const replication = info.replication ?? {};

        const summary: Output = {};
        if (server.redis_version) summary.version = server.redis_version;
        if (server.redis_mode) summary.mode = server.redis_mode;
        if (server.uptime_in_seconds) summary.uptimeSeconds = Number(server.uptime_in_seconds);
        if (replication.role) summary.role = replication.role;
        if (clients.connected_clients) summary.connectedClients = Number(clients.connected_clients);
        if (memory.used_memory) summary.usedMemoryBytes = Number(memory.used_memory);
        if (memory.used_memory_human) summary.usedMemory = memory.used_memory_human;
        if (memory.maxmemory_policy) summary.maxmemoryPolicy = memory.maxmemory_policy;
        if (stats.keyspace_hits && stats.keyspace_misses) {
          const hits = Number(stats.keyspace_hits);
          const misses = Number(stats.keyspace_misses);
          if (hits + misses > 0) summary.hitRate = Number((hits / (hits + misses)).toFixed(4));
        }

        return {
          connection: client.connInfo,
          db: client.db,
          dbSize,
          section,
          summary,
          keyspace: info.keyspace ?? {},
          info,
        };
      }),
    },
  ];
}

// extraArgs reads the "Extra arguments" list without trimming: on the raw
// command action a value's own whitespace is the user's business.
function extraArgs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => rawText(item)).filter((item) => item !== "");
  }
  const text = str(value);
  if (text === "") return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => rawText(item)).filter((item) => item !== "");
    } catch {
      // not JSON — treat it as one argument
    }
  }
  return [text];
}
