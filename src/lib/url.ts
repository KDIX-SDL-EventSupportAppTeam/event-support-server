import type { AppConfig } from '../config.js'

/** フロント URL の base（frontendBaseUrl > corsOrigin の先頭。email-verification.ts と同式）。 */
function frontendBase(config: AppConfig): string {
  return config.frontendBaseUrl ?? config.corsOrigin.split(',')[0].trim()
}

export function buildEventUrls(
  config: AppConfig,
  eventId: string,
): { participant: string; admin: string } {
  const base = frontendBase(config)
  return {
    participant: `${base}/join/${eventId}`,
    admin: `${base}/admin/login?event=${eventId}`,
  }
}

/**
 * ブースの掲示用チェックイン URL（issue #121）。
 *
 * `booth_id`（不変の UUID）だけで決まるため、ブース作成時点で確定する。
 * QR 画像はあとから生成しても同じ URL になる。
 * 生の UUID ではなく `?booth_id=` 付きにして、端末標準カメラで読んだ人が
 * アプリの読み取り画面に着地できるようにする（ブラウザで開いてもチェックインは成立しない）。
 */
export function buildBoothCheckinUrl(config: AppConfig, boothId: string): string {
  return `${frontendBase(config)}/checkin?booth_id=${boothId}`
}
