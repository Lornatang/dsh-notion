import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export interface StoredSession {
  version: 1
  redirectUri?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
}

/** Keep credentials separate for each DSH profile and server. */
export function sessionFileFor(serverName: string, url: string, patchPath?: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverName)) {
    throw new Error('notion: serverName must contain only letters, numbers, underscores or hyphens')
  }
  const profilePatch = patchPath ?? join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return join(dirname(profilePatch), 'data', `dsh-notion-${serverName}-${digest}.json`)
}

/** Reject symlinks and files that cannot be restricted to the service user. */
async function secureExistingFile(file: string): Promise<FileHandle | undefined> {
  let info
  try { info = await lstat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile()) throw new Error(`notion: credential file must be a regular file: ${file}`)
  let handle: FileHandle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`notion: credential file must be a regular file: ${file}`)
    throw error
  }
  try {
    info = await handle.stat()
    if (!info.isFile()) throw new Error(`notion: credential file must be a regular file: ${file}`)
    if (process.platform !== 'win32') {
      if (typeof process.geteuid === 'function' && info.uid !== process.geteuid()) {
        throw new Error(`notion: credential file must be owned by the service user: ${file}`)
      }
      await handle.chmod(0o600)
      info = await handle.stat()
      if ((info.mode & 0o077) !== 0) throw new Error(`notion: cannot secure credential file: ${file}`)
    }
    return handle
  } catch (error) { await handle.close(); throw error }
}

/** Serialize state changes and replace the file only after a complete write. */
export class SessionStore {
  readonly #file: string
  #value: StoredSession = { version: 1 }
  #tail: Promise<unknown> = Promise.resolve()
  #key?: Buffer

  constructor(file: string) { this.#file = file }
  get file(): string { return this.#file }
  get current(): StoredSession { return this.#value }

  async load(): Promise<StoredSession> {
    return this.#serialize(async () => {
      const handle = await secureExistingFile(this.#file)
      if (!handle) return this.#value = { version: 1 }
      let raw: string
      try { raw = await handle.readFile('utf8') } finally { await handle.close() }
      let parsed: unknown
      try {
        const envelope = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
        if (envelope['version'] !== 1 || envelope['algorithm'] !== 'aes-256-gcm' ||
            typeof envelope['iv'] !== 'string' || typeof envelope['tag'] !== 'string' || typeof envelope['ciphertext'] !== 'string') throw new Error('invalid encryption envelope')
        const key = await this.#masterKey(false)
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope['iv'], 'base64'))
        decipher.setAAD(Buffer.from(this.#file))
        decipher.setAuthTag(Buffer.from(envelope['tag'], 'base64'))
        parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope['ciphertext'], 'base64')), decipher.final()]).toString('utf8'))
      } catch (error) {
        throw new Error(`notion: cannot decrypt credential file; check the encryption key and profile path: ${this.#file}`, { cause: error })
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as StoredSession).version !== 1) {
        throw new Error(`notion: invalid credential file: ${this.#file}`)
      }
      this.#value = parsed as StoredSession
      return this.#value
    })
  }

  async patch(patch: Partial<StoredSession>, active?: () => boolean): Promise<void> {
    await this.#serialize(async () => {
      if (active && !active()) throw new Error('notion: connection cancelled')
      const next = { ...this.#value, ...patch, version: 1 as const }
      await this.#flush(next)
      this.#value = next
    })
  }

  async saveTokens(tokens: OAuthTokens, active: () => boolean, expected?: OAuthTokens): Promise<void> {
    await this.#serialize(async () => {
      if (!active()) throw new Error('notion: connection cancelled')
      // A concurrent refresh may already have rotated the credentials.
      if (expected && this.#value.tokens !== expected) return
      const next = { ...this.#value, tokens, version: 1 as const }
      await this.#flush(next)
      this.#value = next
    })
  }

  async clearCredentialsIf(active: () => boolean, expected: OAuthTokens | undefined, ...fields: readonly (keyof StoredSession)[]): Promise<void> {
    await this.#serialize(async () => {
      if (!active()) throw new Error('notion: connection cancelled')
      if (expected && this.#value.tokens !== expected) return
      const next: StoredSession = { ...this.#value, version: 1 }
      for (const field of fields) if (field !== 'version') delete next[field]
      await this.#flush(next)
      this.#value = next
    })
  }

  async clear(...fields: readonly (keyof StoredSession)[]): Promise<void> {
    await this.clearIf(undefined, ...fields)
  }

  async clearIf(active: (() => boolean) | undefined, ...fields: readonly (keyof StoredSession)[]): Promise<void> {
    await this.#serialize(async () => {
      if (active && !active()) throw new Error('notion: connection cancelled')
      const next: StoredSession = { ...this.#value, version: 1 }
      for (const field of fields) if (field !== 'version') delete next[field]
      await this.#flush(next)
      this.#value = next
    })
  }

  async destroy(): Promise<void> {
    await this.#serialize(async () => {
      await (await secureExistingFile(this.#file))?.close()
      await rm(this.#file, { force: true })
      this.#value = { version: 1 }
      this.#key = undefined
      if (!process.env['DSH_NOTION_ENCRYPTION_KEY']) {
        const entry = await this.#keyring()
        await entry.deletePassword()
      }
    })
  }

  async #flush(value: StoredSession): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
    await (await secureExistingFile(this.#file))?.close()
    const key = await this.#masterKey(true)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(this.#file))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    const envelope = { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    const temporary = `${this.#file}.${randomBytes(12).toString('hex')}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.#file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async #keyring(): Promise<import('@napi-rs/keyring').AsyncEntry> {
    const { AsyncEntry } = await import('@napi-rs/keyring')
    const account = createHash('sha256').update(this.#file).digest('hex')
    // A kernel keyring is not durable across logins or reboots; require Secret Service on Linux.
    return new AsyncEntry('dsh-notion', account, { linux: { store: 'secret-service' } })
  }

  async #masterKey(create: boolean): Promise<Buffer> {
    if (this.#key) return this.#key
    const supplied = process.env['DSH_NOTION_ENCRYPTION_KEY']
    let encoded: string | null = supplied ?? null
    try {
      if (!encoded) {
        const entry = await this.#keyring()
        encoded = await entry.getPassword()
        if (!encoded && create) {
          encoded = randomBytes(32).toString('base64')
          await entry.setPassword(encoded)
        }
      }
      if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded) || Buffer.from(encoded, 'base64').length !== 32) {
        throw new Error('encryption key must be a base64-encoded 32-byte value')
      }
      return this.#key = Buffer.from(encoded, 'base64')
    } catch (error) {
      throw new Error('notion: secure key storage is unavailable; unlock the system keychain or set DSH_NOTION_ENCRYPTION_KEY to a persistent base64-encoded 32-byte key', { cause: error })
    }
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }
}
