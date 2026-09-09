import type { AppConfig } from '../config.js'

export function buildEventUrls(
  config: AppConfig,
  eventId: string,
): { participant: string; admin: string } {
  const base =
    config.frontendBaseUrl ?? config.corsOrigin.split(',')[0].trim()
  return {
    // 参加者の入口は /e/:eventId の1本に統合済み（ADR 0004）。
    // /join/:eventId は配布済み・過年度 URL の受け皿としてフロントに残っているが、
    // 参加確定メールという「配り直せない」経路には正規の URL を載せる（issue #126）。
    participant: `${base}/e/${eventId}`,
    admin: `${base}/admin/login?event=${eventId}`,
  }
}
