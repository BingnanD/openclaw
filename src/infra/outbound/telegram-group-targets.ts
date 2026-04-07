const STRAWHAT_PRIMARY_GROUP_ID = "-5016824167";

const STRAWHAT_PRIMARY_GROUP_ALIASES = new Set([
  "-5265166007",
  "草帽研发群",
  "草帽量化研发群",
  "草帽量化大群",
  "草帽量化群",
]);

function normalizeRawTelegramTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^group:/i, "")
    .trim();
}

export function normalizePinnedTelegramGroupTarget(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizeRawTelegramTarget(trimmed);
  if (!normalized) {
    return undefined;
  }
  if (STRAWHAT_PRIMARY_GROUP_ALIASES.has(normalized)) {
    return STRAWHAT_PRIMARY_GROUP_ID;
  }
  return normalized;
}
