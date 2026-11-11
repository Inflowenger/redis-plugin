// A Job stand-in, so an action's handler can be run without a platform.
//
// A handler only ever uses four things off a Job — the request bytes, progress,
// the terminal command, and a context read for {{$.path}} tokens — so this is
// enough to exercise the real handlers end to end against a real Redis.

import type { Action, Job } from "@inflowenger/node-plugin-sdk";

import type { Registry } from "../src/actions/registry.js";

/** What a handler did: the committed output, or the error it failed with. */
export interface Run {
  output?: Record<string, unknown>;
  error?: string;
  frames: { progress: number; title?: string; content?: string }[];
  finishes: number;
}

const encoder = new TextEncoder();

/** fakeJob builds a Job whose request carries `body`, with `scope` for tokens. */
export function fakeJob(body: Record<string, unknown>, scope: Record<string, unknown> = {}): { job: Job; run: Run } {
  const run: Run = { frames: [], finishes: 0 };

  const job = {
    jobId: "test-job",
    req: { data: encoder.encode(JSON.stringify({ _registry: {}, body })) },
    async progress(progress: number, frame?: { title?: string; content?: string }) {
      run.frames.push({ progress, ...frame });
    },
    async done(output: Record<string, unknown>) {
      run.finishes++;
      run.output = output;
    },
    async doneWithError(message: string) {
      run.finishes++;
      run.error = message;
    },
    async cmdGetScope(path: string): Promise<Uint8Array> {
      if (!(path in scope)) throw new Error(`no such path: ${path}`);
      return encoder.encode(JSON.stringify(scope[path]));
    },
  } as unknown as Job;

  return { job, run };
}

/** actionsByMethod indexes a registry's actions, for a test that names one. */
export function actionsByMethod(registry: Registry): Record<string, Action> {
  const out: Record<string, Action> = {};
  for (const action of registry.all()) out[action.method] = action;
  return out;
}

/**
 * call runs one action with the given input and the connection the tests use,
 * and returns what the handler committed. A failed run keeps its error for the
 * test to assert on, rather than throwing.
 */
export async function call(
  registry: Registry,
  method: string,
  input: Record<string, unknown>,
  settings: Record<string, unknown>,
  scope: Record<string, unknown> = {},
): Promise<Run> {
  const action = actionsByMethod(registry)[method];
  if (!action) throw new Error(`no such action: ${method}`);
  const { job, run } = fakeJob({ ...input, settings }, scope);
  await action.requestHandler(job);
  return run;
}

/** ok is `call` for a run that must have succeeded. */
export async function ok(
  registry: Registry,
  method: string,
  input: Record<string, unknown>,
  settings: Record<string, unknown>,
  scope: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const run = await call(registry, method, input, settings, scope);
  if (run.error !== undefined) throw new Error(`${method} failed: ${run.error}`);
  if (!run.output) throw new Error(`${method} committed nothing`);
  return run.output;
}
