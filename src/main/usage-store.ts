import Store from "electron-store";
import type { UsagePage, UsageRow, UsageSummary } from "../shared/bridge.js";

export interface UsageRecord {
  id: string;
  timestamp: number;
  day: string;
  modelId: string;
  modelName: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

interface UsageStoreSchema {
  records: UsageRecord[];
}

const MAX_RECORDS = 5_000;
const PAGE_SIZE = 10;

let store: Store<UsageStoreSchema> | undefined;

function usageStore(): Store<UsageStoreSchema> {
  return store ??= new Store<UsageStoreSchema>({ name: "usage", defaults: { records: [] } });
}

export function recordUsage(entry: Omit<UsageRecord, "id">): void {
  const records = usageStore().get("records");
  const next = [{ id: `${entry.timestamp}-${Math.random().toString(36).slice(2, 8)}`, ...entry }, ...records];
  usageStore().set("records", next.slice(0, MAX_RECORDS));
}

export function clearUsage(): void {
  usageStore().set("records", []);
}

export function getUsageSummary(): UsageSummary {
  const records = usageStore().get("records");
  const summary: UsageSummary = {
    runCount: records.length,
    turns: 0,
    tokens: 0,
    cacheRead: 0,
    cost: 0,
  };
  for (const record of records) {
    summary.turns += record.turns;
    summary.tokens += record.inputTokens + record.outputTokens;
    summary.cacheRead += record.cacheReadTokens;
    summary.cost += record.cost;
  }
  return summary;
}

export function getUsageByDay(page: number): UsagePage {
  const records = usageStore().get("records");
  const byDay = new Map<string, UsageRow>();
  for (const record of records) {
    const row = byDay.get(record.day) ?? {
      key: record.day,
      label: record.day,
      runCount: 0,
      turns: 0,
      tokens: 0,
      cacheRead: 0,
      cost: 0,
    };
    row.runCount += 1;
    row.turns += record.turns;
    row.tokens += record.inputTokens + record.outputTokens;
    row.cacheRead += record.cacheReadTokens;
    row.cost += record.cost;
    byDay.set(record.day, row);
  }
  const rows = [...byDay.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return paginate(rows, page);
}

export function getUsageByModel(page: number): UsagePage {
  const records = usageStore().get("records");
  const byModel = new Map<string, UsageRow>();
  for (const record of records) {
    const key = record.modelId || "unknown";
    const label = record.modelName || record.modelId || "未知模型";
    const row = byModel.get(key) ?? {
      key,
      label,
      runCount: 0,
      turns: 0,
      tokens: 0,
      cacheRead: 0,
      cost: 0,
    };
    row.runCount += 1;
    row.turns += record.turns;
    row.tokens += record.inputTokens + record.outputTokens;
    row.cacheRead += record.cacheReadTokens;
    row.cost += record.cost;
    byModel.set(key, row);
  }
  const rows = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
  return paginate(rows, page);
}

function paginate(rows: UsageRow[], page: number): UsagePage {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  return {
    rows: rows.slice(start, start + PAGE_SIZE),
    page: safePage,
    pageSize: PAGE_SIZE,
    total,
    totalPages,
  };
}

export { PAGE_SIZE };
