import type { DbClient } from '../../db/client.js'

/** db/migrations/02_booth_categories.sql と同一（本番イメージに migrations は含まれない） */
const BOOTH_CATEGORIES_DDL = `
CREATE TABLE IF NOT EXISTS booth_categories (
  booth_id    CHAR(36) NOT NULL,
  category_id CHAR(36) NOT NULL,
  PRIMARY KEY (booth_id, category_id),
  FOREIGN KEY (booth_id)    REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB;
`.trim()

/**
 * さくらプロキシ経由では information_schema への参照が拒否されることがある。
 * 参照に失敗した場合は false を返す（booth_categories は booths 削除の
 * CASCADE でも消えるため、false 側に倒しても安全）。
 */
export async function hasBoothCategoriesTable(db: DbClient): Promise<boolean> {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'booth_categories'`,
    )
    return Number((rows as { c: number }[])[0]?.c ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * booth_categories テーブルが無ければ作成を試みる。
 * さくらプロキシ経由では DDL が 500 になることがあるため、失敗時は false を返す。
 */
export async function ensureBoothCategoriesTable(db: DbClient): Promise<boolean> {
  if (await hasBoothCategoriesTable(db)) return true
  try {
    await db.query(BOOTH_CATEGORIES_DDL)
    return await hasBoothCategoriesTable(db)
  } catch {
    return false
  }
}

export const SAMPLE_PREFIX = '[SAMPLE]'
export const SAMPLE_EMAIL_DOMAIN = 'sample.local'
export const SAMPLE_USER_PASSWORD = 'sample1234'

export const SAMPLE_DEFAULTS = {
  categoryCount: 12,
  boothCount: 18,
  participantCount: 40,
} as const

export function sampleCategoryName(index: number): string {
  return `${SAMPLE_PREFIX} カテゴリ${String(index).padStart(2, '0')}`
}

export function sampleBoothName(index: number): string {
  return `${SAMPLE_PREFIX} ブース${String(index).padStart(2, '0')}`
}

export function sampleParticipantEmail(index: number): string {
  return `sample-${String(index).padStart(3, '0')}@${SAMPLE_EMAIL_DOMAIN}`
}

export function sampleParticipantDisplayName(index: number): string {
  return `${SAMPLE_PREFIX} 参加者${String(index).padStart(3, '0')}`
}

export function sampleManualCode(index: number): string {
  return `S${String(index).padStart(3, '0')}`.slice(0, 6)
}

export function isSampleCategoryName(name: string): boolean {
  return name.startsWith(SAMPLE_PREFIX)
}

export function isSampleBoothName(name: string): boolean {
  return name.startsWith(SAMPLE_PREFIX)
}

export function isSampleSurveyQuestion(text: string): boolean {
  return text.startsWith(SAMPLE_PREFIX)
}

export function isSampleParticipantEmail(email: string): boolean {
  return email.endsWith(`@${SAMPLE_EMAIL_DOMAIN}`)
}
