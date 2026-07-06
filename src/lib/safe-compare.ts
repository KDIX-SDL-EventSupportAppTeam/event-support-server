import { timingSafeEqual } from 'node:crypto'

/**
 * API キー等の比較をタイミング攻撃耐性のある方法で行う。
 * 長さが異なる場合は即 false（timingSafeEqual は同じ長さの Buffer しか比較できないため）。
 */
export function safeCompare(a: string | string[] | undefined, b: string): boolean {
  if (typeof a !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
