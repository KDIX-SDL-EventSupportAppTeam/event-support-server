import { createServer, type Server as HttpServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import { SocketIOFacade } from '../../src/plugins/socket.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

type LogCall = { payload: Record<string, unknown>; msg: string }

function makeFakeLogger() {
  const info: LogCall[] = []
  const warn: LogCall[] = []
  return {
    info: (payload: Record<string, unknown>, msg: string) => {
      info.push({ payload, msg })
    },
    warn: (payload: Record<string, unknown>, msg: string) => {
      warn.push({ payload, msg })
    },
    calls: { info, warn },
  }
}

function signToken(): string {
  return jwt.sign(
    { sub: USER_ID, event_id: EVENT_ID, display_name: 'テスト太郎', role: 'participant' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
}

describe('socket.io の接続・切断ログ（#142）', () => {
  let httpServer: HttpServer
  let facade: SocketIOFacade
  let logger: ReturnType<typeof makeFakeLogger>
  let url: string
  let client: ClientSocket | null = null

  beforeEach(async () => {
    httpServer = createServer()
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    const { port } = httpServer.address() as AddressInfo
    url = `http://localhost:${port}`

    facade = new SocketIOFacade()
    logger = makeFakeLogger()
    facade.init(httpServer, JWT_SECRET, ['*'], logger as unknown as Parameters<SocketIOFacade['init']>[3])
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await facade.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })

  it('T-1: 接続時に socket connected が1回、user_id / transport / clients 付きで出る', async () => {
    client = ioClient(url, { auth: { token: signToken() }, transports: ['websocket'] })
    await new Promise<void>((resolve, reject) => {
      client!.on('connect', () => resolve())
      client!.on('connect_error', reject)
    })
    await new Promise((r) => setTimeout(r, 50))

    const connected = logger.calls.info.filter((c) => c.msg === 'socket connected')
    expect(connected).toHaveLength(1)
    expect(connected[0].payload.user_id).toBe(USER_ID)
    expect(connected[0].payload.role).toBe('participant')
    expect(connected[0].payload.event_id).toBe(EVENT_ID)
    expect(connected[0].payload.transport).toBe('websocket')
    expect(typeof connected[0].payload.socket_id).toBe('string')
    expect(connected[0].payload.clients).toBe(1)
  })

  it('T-2: 切断時に socket disconnected が reason / duration_ms 付きで出る', async () => {
    client = ioClient(url, { auth: { token: signToken() }, transports: ['websocket'] })
    await new Promise<void>((resolve, reject) => {
      client!.on('connect', () => resolve())
      client!.on('connect_error', reject)
    })

    client.disconnect()
    await new Promise((r) => setTimeout(r, 100))

    const disconnected = logger.calls.info.filter((c) => c.msg === 'socket disconnected')
    expect(disconnected).toHaveLength(1)
    expect(disconnected[0].payload.reason).toBeTypeOf('string')
    expect(disconnected[0].payload.duration_ms).toBeGreaterThanOrEqual(0)
    expect(disconnected[0].payload.user_id).toBe(USER_ID)
  })

  it('T-3: ログのどの項目にもトークン文字列が含まれない', async () => {
    const token = signToken()
    client = ioClient(url, { auth: { token }, transports: ['websocket'] })
    await new Promise<void>((resolve, reject) => {
      client!.on('connect', () => resolve())
      client!.on('connect_error', reject)
    })
    client.disconnect()
    await new Promise((r) => setTimeout(r, 100))

    const allCalls = [...logger.calls.info, ...logger.calls.warn]
    for (const call of allCalls) {
      const serialized = JSON.stringify(call.payload)
      expect(serialized).not.toContain(token)
      expect(serialized.toLowerCase()).not.toContain('token')
    }
  })

  it('認証失敗時は warn で socket auth failed が出て、トークンは出さない', async () => {
    client = ioClient(url, { auth: { token: 'not-a-valid-token' }, transports: ['websocket'] })
    await new Promise<void>((resolve) => {
      client!.on('connect_error', () => resolve())
    })
    await new Promise((r) => setTimeout(r, 50))

    const failed = logger.calls.warn.filter((c) => c.msg === 'socket auth failed')
    expect(failed).toHaveLength(1)
    expect(JSON.stringify(failed[0].payload)).not.toContain('not-a-valid-token')
    expect(typeof failed[0].payload.clients).toBe('number')
  })
})
