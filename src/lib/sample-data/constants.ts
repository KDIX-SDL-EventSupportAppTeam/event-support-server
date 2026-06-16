import type { DbClient } from '../../db/client.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const sqlPath = join(repoRoot, 'db/migrations/02_booth_categories.sql')

/** booth_categories テーブルが無ければ作成する（既存 DB 向け） */
export async function ensureBoothCategoriesTable(db: DbClient): Promise<void> {
  const sql = readFileSync(sqlPath, 'utf8')
  await db.query(sql)
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
