import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCcSwitchProviders, toSubscriptionInput } from "../../src/main/cc-switch";

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cc-switch-test-"));
  dbPath = join(directory, "cc-switch.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createDatabase(rows: Array<{ app_type: string; name: string; settings_config: string; category: string }>): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      category TEXT,
      sort_index INTEGER,
      PRIMARY KEY (id, app_type)
    );
  `);
  const insert = db.prepare("INSERT INTO providers (id, app_type, name, settings_config, category, sort_index) VALUES (?, ?, ?, ?, ?, ?)");
  rows.forEach((row, index) => insert.run(`${row.app_type}-${index}`, row.app_type, row.name, row.settings_config, row.category, index));
  db.close();
}

describe("cc-switch detection", () => {
  it("returns an empty list when the database does not exist", () => {
    expect(detectCcSwitchProviders(join(directory, "missing.db"))).toEqual([]);
  });

  it("maps a codex provider TOML into a subscription candidate", () => {
    createDatabase([{
      app_type: "codex",
      name: "DeepSeek Relay",
      category: "third_party",
      settings_config: JSON.stringify({
        auth: { OPENAI_API_KEY: "sk-relay-1" },
        config: [
          'model_provider = "custom"',
          'model = "deepseek-chat"',
          'model_reasoning_effort = "high"',
          '[model_providers.custom]',
          'name = "DeepSeek"',
          'base_url = "https://api.deepseek.com/v1"',
          'wire_api = "responses"',
          'requires_openai_auth = true',
        ].join("\n"),
      }),
    }]);
    const providers = detectCcSwitchProviders(dbPath);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      appType: "codex",
      apiType: "openai-responses",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-relay-1",
    });
    expect(providers[0].models).toEqual([{ id: "DeepSeek", name: "DeepSeek" }, { id: "deepseek-chat", name: "deepseek-chat" }]);
    const input = toSubscriptionInput(providers[0]);
    expect(input.providerId).toContain("cc-switch");
    expect(input.apiKey).toBe("sk-relay-1");
    expect(input.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("maps a claude provider env block into an Anthropic subscription", () => {
    createDatabase([{
      app_type: "claude",
      name: "Kimi Anthropic",
      category: "third_party",
      settings_config: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
          ANTHROPIC_AUTH_TOKEN: "sk-kimi-1",
          ANTHROPIC_MODEL: "kimi-k2.7-code",
        },
      }),
    }]);
    const providers = detectCcSwitchProviders(dbPath);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      apiType: "anthropic-messages",
      baseUrl: "https://api.moonshot.cn/anthropic",
      apiKey: "sk-kimi-1",
    });
    expect(providers[0].models).toEqual([{ id: "kimi-k2.7-code", name: "kimi-k2.7-code" }]);
  });

  it("maps a gemini provider env block into a Google subscription", () => {
    createDatabase([{
      app_type: "gemini",
      name: "Gemini Relay",
      category: "third_party",
      settings_config: JSON.stringify({
        env: {
          GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
          GEMINI_API_KEY: "sk-gemini-1",
          GEMINI_MODEL: "gemini-2.5-pro",
        },
        config: {},
      }),
    }]);
    const providers = detectCcSwitchProviders(dbPath);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      apiType: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "sk-gemini-1",
    });
  });

  it("skips official providers and unmappable rows", () => {
    createDatabase([
      { app_type: "codex", name: "OpenAI Official", category: "official", settings_config: JSON.stringify({ auth: {}, config: "" }) },
      { app_type: "grokbuild", name: "Grok Custom", category: "custom", settings_config: JSON.stringify({ config: "" }) },
      { app_type: "codex", name: "Broken", category: "custom", settings_config: "not-json" },
    ]);
    expect(detectCcSwitchProviders(dbPath)).toEqual([]);
  });

  it("handles a malformed sqlite file without throwing", () => {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(dbPath, "this is not a sqlite database");
    expect(detectCcSwitchProviders(dbPath)).toEqual([]);
  });
});
