import { describe, expect, it } from 'vitest'
import { safeCompare } from '../../src/lib/safe-compare.js'

describe('safeCompare', () => {
  it('一致する文字列は true', () => {
    expect(safeCompare('secret-key', 'secret-key')).toBe(true)
  })

  it('不一致の文字列は false', () => {
    expect(safeCompare('wrong-key', 'secret-key')).toBe(false)
  })

  it('長さが異なる場合は false', () => {
    expect(safeCompare('short', 'much-longer-secret-key')).toBe(false)
  })

  it('undefined は false', () => {
    expect(safeCompare(undefined, 'secret-key')).toBe(false)
  })

  it('文字列配列（ヘッダの多重指定）は false', () => {
    expect(safeCompare(['a', 'b'], 'secret-key')).toBe(false)
  })
})
