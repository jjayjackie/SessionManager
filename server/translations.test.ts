import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROVIDERS, ReasonCodeSchema, WarningSchema } from "../shared/schema";

/**
 * Mirrors the checks `defineTranslations` runs when the client bundle loads (Paseo plugin SDK,
 * client/translations.tsx): a failure there would stop the plugin from loading at all.
 */

type Resource = { [key: string]: string | Resource };

function flatten(resource: Resource, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(resource)) {
    assert.ok(key && !key.includes(".") && !["__proto__", "constructor", "prototype"].includes(key), `invalid key ${prefix}${key}`);
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.set(path, value);
    else for (const entry of flatten(value, path)) result.set(...entry);
  }
  return result;
}
const pluralBase = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");
const placeholders = (value: string) => [...new Set([...value.matchAll(/{{-?\s*([^},\s]+)(?:[^}]*)}}/g)].map((match) => match[1]))].sort().join(",");

async function load(locale: string): Promise<Map<string, string>> {
  return flatten(JSON.parse(await readFile(join(__dirname, "..", "client", "locales", `${locale}.json`), "utf8")) as Resource);
}

describe("translations", () => {
  it("zh-CN uses only English keys with identical placeholders", async () => {
    const en = await load("en");
    const zh = await load("zh-CN");
    assert.equal(Intl.getCanonicalLocales("zh-CN")[0], "zh-CN");
    for (const [key, value] of zh) {
      const source = en.get(key) ?? en.get(`${pluralBase(key)}_other`);
      assert.ok(source !== undefined, `Unknown translation key in zh-CN: ${key}`);
      assert.equal(placeholders(value), placeholders(source), `Placeholders differ: ${key}`);
    }
  });

  it("covers every English key in Simplified Chinese", async () => {
    const en = await load("en");
    const zh = await load("zh-CN");
    const missing = [...en.keys()].filter((key) => !zh.has(key) && !zh.has(`${pluralBase(key)}_other`));
    assert.deepEqual(missing, []);
  });

  it("has a message for every provider, reason, warning, and host status the UI can show", async () => {
    const en = await load("en");
    for (const provider of PROVIDERS) assert.ok(en.has(`provider.${provider}`), provider);
    for (const code of ReasonCodeSchema.options) assert.ok(en.has(`reason.${code}`), code);
    for (const code of WarningSchema.shape.code.options) assert.ok(en.has(`warning.${code}`), code);
    for (const status of ["idle", "connecting", "online", "offline", "error"]) assert.ok(en.has(`host.${status}`), status);
  });
});
