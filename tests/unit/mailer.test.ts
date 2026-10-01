import { describe, expect, it } from 'vitest'
import { buildMailOptions, extractMailAddress } from '../../src/lib/mailer.js'
import {
  VERIFICATION_TOKEN_TTL_HOURS,
  buildVerificationMailHtml,
  buildVerificationMailText,
} from '../../src/lib/email-verification.js'

const MAIL_FROM = 'PRoToFES <no-reply@example.com>'

describe('extractMailAddress', () => {
  it('表示名付き・アドレスのみの両方から取り出す', () => {
    expect(extractMailAddress('PRoToFES <no-reply@example.com>')).toBe('no-reply@example.com')
    expect(extractMailAddress('no-reply@example.com')).toBe('no-reply@example.com')
    expect(extractMailAddress('not an address')).toBeNull()
  })
})

describe('buildMailOptions（issue #157）', () => {
  const msg = { to: 'a@b.test', subject: 's', text: 't', from: 'event@other.test' }

  it('From は MAIL_FROM のまま、イベント固有の mail_from は Reply-To に入る', () => {
    const o = buildMailOptions({ mailFrom: MAIL_FROM }, msg)
    expect(o.from).toBe(MAIL_FROM)
    expect(o.replyTo).toBe('event@other.test')
  })

  it('List-Unsubscribe が mailto: 形式で付き、Message-ID のドメインが From と揃う', () => {
    const o = buildMailOptions({ mailFrom: MAIL_FROM }, msg)
    expect(o.headers?.['List-Unsubscribe']).toBe('<mailto:no-reply@example.com?subject=unsubscribe>')
    expect(o.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/)
  })

  it('html は渡されたときだけ含める（既存の呼び出しを壊さない）', () => {
    expect('html' in buildMailOptions({ mailFrom: MAIL_FROM }, msg)).toBe(false)
    expect(buildMailOptions({ mailFrom: MAIL_FROM }, { ...msg, html: '<p>x</p>' }).html).toBe('<p>x</p>')
  })

  it('MAIL_FROM からアドレスが取れなくても壊れない（ヘッダを足さない）', () => {
    const o = buildMailOptions({ mailFrom: 'broken' }, msg)
    expect(o.headers).toBeUndefined()
    expect(o.messageId).toBeUndefined()
  })
})

describe('確認メールの本文（issue #157）', () => {
  const url = 'https://front.example/verify-email?token=abc'

  it('何のメールか・送信者・有効期限を書き、迷惑メール案内は書かない', () => {
    const text = buildVerificationMailText('山田', url)
    expect(text).toContain('PRoToFES 運営')
    expect(text).toContain('メールアドレスの確認')
    expect(text).toContain(`${VERIFICATION_TOKEN_TTL_HOURS} 時間`)
    expect(text).not.toContain('迷惑メール')
  })

  it('HTML 版はテキスト版と同じ URL・有効期限を持ち、外部画像を含まない', () => {
    const html = buildVerificationMailHtml('山田', url)
    expect(html).toContain(`href="${url}"`)
    expect(html).toContain(`${VERIFICATION_TOKEN_TTL_HOURS} 時間`)
    expect(html).toContain('PRoToFES 運営')
    expect(html).not.toMatch(/<img|src=|url\(/i)
  })

  it('HTML 版は表示名をエスケープする', () => {
    const html = buildVerificationMailHtml('<script>alert(1)</script>', url)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
