/** 機械可読な運用ログを1行JSONとして整形する。秘匿値は渡さないこと。 */
export function formatOperationalEvent(
  event: string,
  fields: Record<string, unknown> = {}
): string {
  const safe: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    safe[key] =
      typeof value === 'string' && value.length > 160
        ? `${value.slice(0, 160)}…`
        : value;
  }
  return JSON.stringify(safe);
}
