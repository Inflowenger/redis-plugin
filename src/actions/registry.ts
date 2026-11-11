// Wires the Redis client onto the plugin's node actions, and owns the two things
// every action shares: the pool that turns each call's settings profile into a
// client, and the job runner that decodes a request, resolves {{$.path}} tokens
// and terminates the job exactly once.
//
// The action surface itself lives in the group files (keys, hash, lists, sets,
// streams, server), each of which is handed only this file's `run`.

import {
  castRequestTo,
  formkit,
  type Action,
  type FormBuilder,
  type Job,
  type Meta,
  type Request,
  type Settings,
} from "@inflowenger/node-plugin-sdk";

import type { Client } from "../redis/client.js";
import { Pool } from "../redis/settings.js";
import { asNumber, asString } from "../redis/value.js";
import { formsByMethod, settingsForm } from "./forms.js";
import { hashActions } from "./hash.js";
import { errText, str, type Handler, type Kit } from "./kit.js";
import { keyActions } from "./keys.js";
import { listActions } from "./lists.js";
import { M } from "./methods.js";
import { serverActions } from "./server.js";
import { setActions } from "./sets.js";
import { streamActions } from "./streams.js";
import { resolveInputVars, VarResolver } from "./vars.js";

// How many keys the form's keyspace picker offers at once. It is a dialog, not a
// report: a wider match is narrowed by typing more of the name.
const maxPickKeys = 50;

/**
 * Registry owns what the actions share: the pool that turns each call's settings
 * profile into a client. The plugin holds no server configuration of its own.
 */
export class Registry {
  private readonly pool = new Pool();

  private readonly kit: Kit = {
    run: (title: string, handler: Handler) => this.run(title, handler),
  };

  /** Every action this plugin exposes, grouped the way the canvas shows them. */
  all(): Action[] {
    return [
      ...keyActions(this.kit),
      ...hashActions(this.kit),
      ...listActions(this.kit),
      ...setActions(this.kit),
      ...streamActions(this.kit),
      ...serverActions(this.kit),
    ];
  }

  /** The meta RPCs: test a connection, and search the keyspace from a form. */
  metas(): Meta[] {
    return [
      { method: M.metaPing, requestHandler: (req) => this.metaPing(req) },
      { method: M.metaKeyPick, requestHandler: (req) => this.metaKeyPick(req) },
    ];
  }

  /** The settings profile: the form plus the submit handler that validates it. */
  settings(): Settings {
    return {
      ...settingsForm,
      submitHandler: async (req) => {
        let client: Client;
        try {
          client = this.pool.client(connFrom(decodeMeta(req.data)));
        } catch (e) {
          return { error: errText(e) };
        }
        try {
          await client.ping();
        } catch (e) {
          return { error: "connection test failed: " + errText(e) };
        }
        return { data: { ok: true, connectedTo: client.connInfo } };
      },
    };
  }

  /** The same form for PluginIntro.settings — the plugin set-up dialog reads it. */
  settingsForm(): FormBuilder {
    return settingsForm;
  }

  /** Close every pooled connection. For a graceful shutdown and for tests. */
  async close(): Promise<void> {
    await this.pool.closeAll();
  }

  // ------------------------------------------------------------- the runner --

  // run adapts a handler into an SDK job handler: decode the typed body and the
  // connection that came with it, resolve the client, resolve {{$...}} tokens in
  // every string input, report progress, and terminate the job exactly once on
  // every path.
  private run(title: string, handler: Handler): (job: Job) => Promise<void> {
    return async (job: Job) => {
      let input: Record<string, unknown>;
      let settings: Record<string, unknown> | undefined;
      try {
        const req = castRequestTo<Record<string, unknown> & { settings?: Record<string, unknown> }>(
          job.req.data,
        );
        input = { ...(req.body ?? {}) };
        settings = (input.settings as Record<string, unknown>) ?? undefined;
        delete input.settings; // the connection travels separately, not as action input
      } catch (e) {
        await job.doneWithError("invalid request body: " + errText(e));
        return;
      }

      let client: Client;
      try {
        client = this.pool.client(settings);
      } catch (e) {
        await job.doneWithError(errText(e));
        return;
      }

      const resolver = new VarResolver(job);
      try {
        // Resolve {{$...}} tokens in every string input against the flow scope,
        // so a key, a value, a channel or a member can reference upstream data.
        await resolveInputVars(job, input, resolver);

        await job.progress(20, { title, content: "on " + client.connInfo });

        const out = await handler(job, client, input, resolver);

        await job.progress(90, { title, content: "committing result" });
        await job.done(out ?? {});
      } catch (e) {
        await job.doneWithError(errText(e));
      }
    };
  }

  // --------------------------------------------------------------- the metas --

  // metaPing backs the settings form's "Test connection" button and its submit
  // validation. It opens the connection being edited and pings it, so a wrong
  // host or password is reported in the dialog instead of failing every node
  // later.
  private async metaPing(req: Request): Promise<unknown> {
    let client: Client;
    try {
      client = this.pool.client(connFrom(decodeMeta(req.data)));
    } catch (e) {
      return formkit.failure("%s", errText(e)).patch(null);
    }
    try {
      await client.ping();
    } catch (e) {
      return formkit.failure("cannot reach %s: %s", client.connInfo, errText(e)).patch(null);
    }

    const version = await client.serverVersion();
    let keys = -1;
    try {
      keys = asNumber(await client.send("DBSIZE", []));
    } catch {
      // DBSIZE can be denied by an ACL that still allows PING — the connection
      // works, which is what the button was asked about.
    }

    // A patch with nothing but a message: the test writes no value into the
    // profile, and saying what it found is the whole point of the button.
    return formkit
      .success(
        "Connected to %s%s%s.",
        client.connInfo,
        version !== "" ? ` — Redis ${version}` : "",
        keys >= 0 ? `, ${keys} key(s) in this database` : "",
      )
      .patch(null);
  }

  // metaKeyPick backs the ↻ button on every Key field. It reads what the box
  // holds (posted as `value`) and searches the keyspace with SCAN:
  //
  //   - empty box → the first keys on the server, to pick from;
  //   - a partial name → matched as <name>*;
  //   - a glob → used as typed.
  //
  // One match is written straight into the field; several rebuild the open
  // dialog with the field as a drop-down (which form that is comes from
  // formkit's `.picks()`, posted as `form`).
  private async metaKeyPick(req: Request): Promise<unknown> {
    const call = decodeMeta(req.data);
    let client: Client;
    try {
      client = this.pool.client((call.settings as Record<string, unknown>) ?? undefined);
    } catch (e) {
      return formkit.failure("%s", errText(e)).patch(null);
    }

    const target = str(call.targetField) || "key";
    const typed = str(call.value) || str(call[target]);
    const pattern = typed === "" ? "*" : typed.includes("*") ? typed : `${typed}*`;

    let keys: string[];
    try {
      const page = await client.scan({ match: pattern, max: maxPickKeys });
      keys = page.items;
    } catch (e) {
      return formkit.failure("cannot scan %s: %s", client.connInfo, errText(e)).about(target).patch(null);
    }

    if (keys.length === 0) {
      return formkit
        .warning("no key matches %s on %s", pattern, client.connInfo)
        .about(target)
        .patch(null);
    }

    if (keys.length === 1 && typed !== "") {
      const key = keys[0];
      const type = await this.typeOf(client, key);
      return formkit.success("%s — %s", key, type).about(target).patch({ [target]: key });
    }

    // Label each candidate with its type: on a Redis server the name alone
    // rarely says whether it is a hash, a list or a stream.
    const types = await this.typesOf(client, keys);
    const options = keys.map((key, i) => ({ value: key, label: `${key} — ${types[i]}` }));

    const heading = formkit
      .success("%s key(s) matching %s — pick one", options.length, pattern)
      .about(target);
    const form = formsByMethod[str(call.form)] ?? ({ jsonschema: "" } as FormBuilder);
    return formkit.choose(form, target, options, formkit.formData(call), heading);
  }

  private async typeOf(client: Client, key: string): Promise<string> {
    try {
      return asString(await client.send("TYPE", [key]));
    } catch {
      return "?";
    }
  }

  private async typesOf(client: Client, keys: string[]): Promise<string[]> {
    try {
      const replies = await client.batch(
        keys.map((key) => ["TYPE", key] as [string, string]),
        true,
      );
      return replies.map((reply) => (reply instanceof Error ? "?" : asString(reply)));
    } catch {
      return keys.map(() => "?");
    }
  }
}

// ---------------------------------------------------------------- helpers --

// connFrom pulls the profile values out of a meta/submit call. On an action's
// drawer the bound profile is under "settings"; the set-up dialog has no bound
// profile and sends the edited values at the top level, alongside host keys.
function connFrom(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.settings;
  if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
    return nested as Record<string, unknown>;
  }
  const conn = { ...body };
  for (const hostKey of ["settings", "value", "targetField", "form"]) delete conn[hostKey];
  return conn;
}

// decodeMeta reads a meta RPC's arguments, tolerating the {_registry, body}
// envelope or a bare object, and treating anything unreadable as "no arguments".
function decodeMeta(data: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(data).trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed.body === "object" && parsed.body !== null) {
      return parsed.body as Record<string, unknown>;
    }
    return parsed;
  } catch {
    return {};
  }
}
