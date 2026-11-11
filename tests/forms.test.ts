// Every form parses, every control points at a property that exists, and no
// action form asks for a connection — the three ways a form goes wrong without
// anyone noticing until a dialog will not open.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { allForms, formsByMethod, settingsForm } from "../src/actions/forms.js";
import { M } from "../src/actions/methods.js";
import { Registry } from "../src/actions/registry.js";

// The keys that belong to the connection and must never appear on an action
// form: they live on the settings profile and arrive as body.settings.
const connectionKeys = ["settings", "url", "host", "port", "password", "username", "db", "tls", "tlsInsecure"];

function schemaOf(form: { jsonschema?: string }): { properties?: Record<string, unknown>; required?: string[] } {
  assert.ok(form.jsonschema, "the form has no JSON Schema");
  return JSON.parse(form.jsonschema) as { properties?: Record<string, unknown>; required?: string[] };
}

function scopesOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) scopesOf(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record.scope === "string") out.push(record.scope);
    for (const value of Object.values(record)) scopesOf(value, out);
  }
  return out;
}

test("every form's schema and UI schema parse", () => {
  for (const [name, form] of Object.entries(allForms)) {
    assert.doesNotThrow(() => schemaOf(form), `${name}: schema does not parse`);
    assert.ok(form.jsonui, `${name}: no UI schema`);
    assert.doesNotThrow(() => JSON.parse(form.jsonui as string), `${name}: UI schema does not parse`);
  }
});

test("every control points at a property the schema declares", () => {
  for (const [name, form] of Object.entries(allForms)) {
    const properties = schemaOf(form).properties ?? {};
    for (const scope of scopesOf(JSON.parse(form.jsonui as string))) {
      const property = scope.replace("#/properties/", "");
      assert.ok(property in properties, `${name}: the UI points at #/properties/${property}, which is not declared`);
    }
  }
});

test("no action form asks for a connection value", () => {
  const registry = new Registry();
  for (const action of registry.all()) {
    if (!action.form) continue;
    const properties = Object.keys(schemaOf(action.form).properties ?? {});
    for (const key of connectionKeys) {
      assert.ok(
        !properties.includes(key),
        `${action.method}: the form declares "${key}", which belongs to the settings profile`,
      );
    }
  }
});

test("the settings form asks for the connection, and tests it", () => {
  const properties = Object.keys(schemaOf(settingsForm).properties ?? {});
  for (const key of ["url", "host", "port", "db", "username", "password", "tls"]) {
    assert.ok(properties.includes(key), `the settings form is missing "${key}"`);
  }
  assert.equal(settingsForm.submit_to, M.metaPing);
});

test("every action has a unique method, a handler and a form", () => {
  const registry = new Registry();
  const actions = registry.all();
  const seen = new Set<string>();
  for (const action of actions) {
    assert.ok(!seen.has(action.method), `duplicate method: ${action.method}`);
    seen.add(action.method);
    assert.equal(typeof action.requestHandler, "function", `${action.method}: no handler`);
    assert.ok(action.form, `${action.method}: no form`);
    assert.ok(action.title && action.title.length > 0, `${action.method}: no title`);
    assert.ok(action.description && action.description.length > 20, `${action.method}: no description`);
    assert.ok(action.tags?.class, `${action.method}: no class tag to group it by`);
  }
  assert.ok(actions.length >= 20, `expected the full surface, got ${actions.length} actions`);
});

test("every method the forms index is a method the plugin serves", () => {
  const served = new Set(new Registry().all().map((action) => action.method));
  for (const method of Object.keys(formsByMethod)) {
    assert.ok(served.has(method), `formsByMethod names ${method}, which no action serves`);
  }
});

test("every field a form declares is read by a handler", () => {
  // A form field whose name no handler reads is a field that silently does
  // nothing — the commonest way a form and its handler drift apart.
  const source = readdirSync(new URL("../src/actions/", import.meta.url))
    .filter((file) => file.endsWith(".ts") && !["forms.ts", "methods.ts"].includes(file))
    .map((file) => readFileSync(new URL(`../src/actions/${file}`, import.meta.url), "utf8"))
    .join("\n");
  const read = new Set([...source.matchAll(/input\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));

  for (const action of new Registry().all()) {
    const properties = Object.keys(schemaOf(action.form ?? {}).properties ?? {});
    for (const property of properties) {
      assert.ok(read.has(property), `${action.method}: the form declares "${property}", which no handler reads`);
    }
  }
});

test("every key picker names the form it rebuilds", () => {
  // formkit's .picks() posts the method under `form`; without it an ambiguous
  // search can only list what it found as text.
  for (const [method, form] of Object.entries(formsByMethod)) {
    const ui = JSON.stringify(JSON.parse(form.jsonui as string));
    assert.ok(ui.includes(M.metaKeyPick), `${method}: the key field has no picker`);
    assert.ok(ui.includes(`"form":"${method}"`), `${method}: the picker does not name its own form`);
  }
});
