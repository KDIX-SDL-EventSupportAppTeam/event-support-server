import type { AppConfig } from '../config.js'

export function buildEventUrls(
  config: AppConfig,
  eventId: string,
): { participant: string; admin: string } {
  const base =
    config.frontendBaseUrl ?? config.corsOrigin.split(',')[0].trim()
  return {
    participant: `${base}/join/${eventId}`,
    admin: `${base}/admin/login?event=${eventId}`,
  }
}
