// Command redis-plugin is an Inflowenger plugin node for Redis (and Valkey).
//
// It puts the Redis data types on the workflow canvas — strings and counters,
// hashes, lists as queues, sets, sorted sets, streams, pub/sub — plus one
// escape-hatch action that runs any command, over a connection the platform
// ships with every call.
//
// The plugin holds no server configuration. It declares what a connection needs
// (see the settings form); the platform stores the filled-in form as a named
// settings profile and folds the values into every call as body.settings. One
// running plugin serves many Redis servers, and rotating a password needs no
// redeploy. The Node/TypeScript sibling of the ClickHouse and MySQL plugins.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newPlugin, withDotEnv, withTimeout } from "@inflowenger/node-plugin-sdk";

import { Registry } from "./actions/registry.js";

const version = "v0.1.0";

// Redis itself answers in microseconds, but two of the actions wait on purpose —
// a blocking list pop and a blocking stream read — for as long as the form lets
// a flow ask for (60s). The send deadline has to sit above that, or a legitimate
// wait comes back as a bare NATS "TIMEOUT". REQ_TIMEOUT overrides it at deploy.
const SEND_TIMEOUT_SECONDS = 130;

// The manual is authored as Markdown next to this module (src/manual.md, copied
// to dist/manual.md by the build) and rendered by the host on the plugin's page.
// Read it relative to this file so it resolves under both `tsx src` (dev) and
// `node dist` (prod); fall back to an empty manual if it is missing.
function loadManual(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "manual.md"), "utf8");
  } catch (e) {
    console.warn("redis plugin: manual.md not found, serving empty manual:", e);
    return "";
  }
}

const envFile = process.env.INFLOW_ENV_FILE || ".env.inflow";

async function main() {
  // The dotenv carries the platform identity only — PLUGIN_ID, INFRA_CRED,
  // INFRA_URL. Redis credentials never live here.
  const p = await newPlugin(withDotEnv(envFile), withTimeout(SEND_TIMEOUT_SECONDS));

  const registry = new Registry();

  p.intro({
    name: "REDIS",
    author: "FloMorphic",
    version,
    settings: registry.settingsForm(),
    manual: loadManual(),
  });
  p.requiredParams(registry.settings());

  const actions = registry.all();
  p.addAction(...actions);
  p.addMeta(...registry.metas());

  p.start();

  const methods = actions.map((a) => a.method).join(", ");
  console.log(`redis plugin ${version} ready with ${actions.length} actions: ${methods}`);
  console.log(
    "redis plugin: each call brings its own connection in body.settings — bind a settings profile to the node",
  );

  // Close the pooled connections on the way out, so a restart does not leave
  // sockets on the server waiting for their timeout.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void registry.close().finally(() => process.exit(0));
    });
  }

  // start() only wires up subscriptions; the process has to stay alive to serve
  // them.
  await new Promise(() => {});
}

main().catch((e) => {
  // The usual failure here is the platform identity: no dotenv, or an Infra that
  // is not reachable. Say which file was read before printing the cause, so the
  // first line of the log is the thing to fix.
  console.error(`redis plugin: cannot start with ${envFile} — check PLUGIN_ID, INFRA_CRED and INFRA_URL`);
  console.error(e);
  process.exit(1);
});
