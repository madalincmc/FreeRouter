import type { FastifyInstance } from 'fastify'
import { generateToken, startGateway, type GatewayDeps } from '@core/gateway/server'
import type { Encryptor } from '@core/keys/vault'
import { redactError } from '@core/security/redact'
import type { GatewayStatus } from '@shared/ipc'
import type { SettingsStore } from './db'

export const DEFAULT_GATEWAY_PORT = 4141

/**
 * Owns the gateway's lifecycle (start/stop/restart on port change) and its token. The token is
 * stored encrypted with safeStorage like provider keys; if encryption is unavailable it lives in
 * memory only and is regenerated on every start.
 */
export class GatewayController {
  private app: FastifyInstance | null = null
  private runningPort: number | null = null
  private error: string | null = null
  private token = ''
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: Omit<GatewayDeps, 'token'>,
    private readonly settings: SettingsStore,
    private readonly enc: Encryptor,
    private readonly onChange: (s: GatewayStatus) => void
  ) {}

  async init(): Promise<void> {
    const stored = this.settings.get<string | null>('gateway.tokenEnc', null)
    if (stored && (await this.enc.isAvailable())) {
      try {
        this.token = (await this.enc.decrypt(Buffer.from(stored, 'base64'))).result
      } catch {
        this.token = ''
      }
    }
    if (!this.token) await this.regenerateToken()
    await this.apply()
  }

  getToken(): string {
    return this.token
  }

  async regenerateToken(): Promise<string> {
    this.token = generateToken()
    if (await this.enc.isAvailable()) {
      this.settings.set('gateway.tokenEnc', (await this.enc.encrypt(this.token)).toString('base64'))
    }
    return this.token
  }

  status(): GatewayStatus {
    const port = this.port()
    return {
      enabled: this.settings.get('gateway.enabled', true),
      port,
      running: this.app !== null,
      error: this.error,
      baseUrl: `http://127.0.0.1:${this.runningPort ?? port}/v1`
    }
  }

  async setEnabled(enabled: boolean): Promise<GatewayStatus> {
    this.settings.set('gateway.enabled', enabled)
    await this.apply()
    return this.status()
  }

  async setPort(port: number): Promise<GatewayStatus> {
    this.settings.set('gateway.port', port)
    await this.apply()
    return this.status()
  }

  /** Brings the server in line with settings; serialised so toggles can't race. */
  apply(): Promise<void> {
    this.chain = this.chain.then(() => this.reconcile()).catch(() => {})
    return this.chain
  }

  async stop(): Promise<void> {
    await this.chain
    await this.close()
  }

  private port(): number {
    return this.settings.get('gateway.port', DEFAULT_GATEWAY_PORT)
  }

  private async close(): Promise<void> {
    if (!this.app) return
    const app = this.app
    this.app = null
    this.runningPort = null
    await app.close().catch(() => {})
  }

  private async reconcile(): Promise<void> {
    const { enabled } = this.status()
    const port = this.port()
    if (!enabled) {
      await this.close()
      this.error = null
    } else if (!this.app || this.runningPort !== port) {
      await this.close()
      try {
        this.app = await startGateway({ ...this.deps, token: () => this.token }, port)
        this.runningPort = port
        this.error = null
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        this.error = code === 'EADDRINUSE' ? `Port ${port} is already in use` : redactError(err)
      }
    }
    this.onChange(this.status())
  }
}
