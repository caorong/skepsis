/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { createApp, type App, type AppOptions } from '../dist/lib.js'
import type { MountedSummary } from './protocol.ts'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const ROUTE_RE = /^\/wt\/([a-f0-9]{12})(\/.*)?$/

export type ServerConfig = {
  tabSize: number
  diffBase: string
  orcaBinary: string
}

export type MountTarget = {
  workspaceId: string | null
  name: string
  branch: string | null
  path: string
}

type MountedEntry = {
  slug: string
  workspaceId: string | null
  name: string
  branch: string | null
  path: string
  app: App
  diffBase: string
  configKey: string
  startedAt: number
}

export type CreateAppFn = (opts: AppOptions) => Promise<App>

/**
 * Checks whether a workspace lives on this local machine (not SSH, paired
 * runtime, or WSL UNC share) so the local loopback Skepsis server can read it.
 */
export function isLocalWorkspace(
  hostId: string | null | undefined,
  path: string | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (hostId != null && hostId !== 'local') {
    return {
      ok: false,
      reason: `Workspace is on ${hostId}. Skepsis only supports local workspaces.`,
    }
  }
  if (!path) {
    return { ok: false, reason: 'Workspace has no local directory path.' }
  }
  const lower = path.toLowerCase()
  if (
    lower.startsWith('\\\\wsl.localhost\\') ||
    lower.startsWith('\\\\wsl$\\') ||
    lower.startsWith('//wsl.localhost/')
  ) {
    return {
      ok: false,
      reason: 'WSL workspaces cannot be served from the desktop worker.',
    }
  }
  return { ok: true }
}

export function worktreeSlug(realPath: string): string {
  return createHash('sha256').update(realPath).digest('hex').slice(0, 12)
}

export function buildBrowserOpenCommand(
  url: string,
  openCommand?: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  const custom = openCommand?.trim()
  if (custom) {
    if (platform === 'win32') {
      return { cmd: 'cmd', args: ['/c', `${custom} "%~1"`, url] }
    }
    // Pass URL via positional "$1" so shell metacharacters are never parsed.
    return { cmd: 'sh', args: ['-c', `${custom} "$1"`, 'sh', url] }
  }
  switch (platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] }
    case 'win32':
      return { cmd: 'cmd', args: ['/c', 'start', '', url] }
    default:
      return { cmd: 'xdg-open', args: [url] }
  }
}

export function launchBrowser(url: string, openCommand?: string): Promise<void> {
  const { cmd, args } = buildBrowserOpenCommand(url, openCommand)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    let settled = false
    child.once('error', (err) => {
      if (!settled) {
        settled = true
        reject(
          new Error(`Could not launch browser (${cmd}): ${err.message}`, { cause: err }),
        )
      }
    })
    child.once('spawn', () => {
      if (!settled) {
        settled = true
        child.unref()
        resolve()
      }
    })
  })
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new Error('Request body too large')
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function toWebHeaders(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  const setCookies = response.headers.getSetCookie?.() ?? []
  if (setCookies.length > 0) {
    res.setHeader('set-cookie', setCookies)
  }
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return
    res.setHeader(key, value)
  })
  if (!response.body) {
    res.end()
    return
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
    stream.on('error', reject)
    res.on('close', resolve)
    res.on('finish', resolve)
    stream.pipe(res)
  })
}

export class SkepsisServerManager {
  #server: Server | null = null
  #starting: Promise<number> | null = null
  #port: number | null = null
  #byPath = new Map<string, MountedEntry>()
  #bySlug = new Map<string, MountedEntry>()
  #mounting = new Map<string, Promise<MountedSummary>>()
  #createApp: CreateAppFn

  constructor(createAppFn: CreateAppFn = createApp) {
    this.#createApp = createAppFn
  }

  get running(): boolean {
    return this.#server !== null && this.#port !== null
  }

  get port(): number | null {
    return this.#port
  }

  #urlFor(entry: MountedEntry): string {
    if (this.#port === null) {
      throw new Error('Skepsis HTTP server is not running')
    }
    const fragment = entry.app.token ? `#token=${entry.app.token}` : ''
    return `http://${LOOPBACK_HOST}:${this.#port}/wt/${entry.slug}/${fragment}`
  }

  #summarize(entry: MountedEntry): MountedSummary {
    return {
      slug: entry.slug,
      workspaceId: entry.workspaceId,
      name: entry.name,
      branch: entry.branch,
      path: entry.path,
      url: this.#urlFor(entry),
      diffBase: entry.diffBase,
      startedAt: entry.startedAt,
    }
  }

  listMounted(): MountedSummary[] {
    if (!this.running) return []
    return [...this.#byPath.values()]
      .toSorted((a, b) => b.startedAt - a.startedAt)
      .map((entry) => this.#summarize(entry))
  }

  findByPath(path: string | null | undefined): MountedSummary | null {
    if (!path || !this.running) return null
    let canonical = path
    try {
      canonical = realpathSync(path)
    } catch {
      // Fall back to the raw path if the directory was removed.
    }
    const entry = this.#byPath.get(canonical) ?? this.#byPath.get(path)
    return entry ? this.#summarize(entry) : null
  }

  async #ensureServer(): Promise<number> {
    if (this.#server && this.#port !== null) return this.#port
    if (this.#starting) return this.#starting

    this.#starting = new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.#handleHttp(req, res)
      })
      server.once('error', (err) => {
        this.#starting = null
        reject(err)
      })
      server.listen(0, LOOPBACK_HOST, () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          server.close()
          this.#starting = null
          reject(new Error('Could not bind local loopback port'))
          return
        }
        this.#server = server
        this.#port = addr.port
        this.#starting = null
        resolve(addr.port)
      })
    })
    return this.#starting
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? `${LOOPBACK_HOST}:${this.#port ?? 0}`
      const parsed = new URL(req.url ?? '/', `http://${host}`)
      const match = ROUTE_RE.exec(parsed.pathname)
      if (!match) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('Not found')
        return
      }
      const slug = match[1]!
      const rest = match[2]
      const entry = this.#bySlug.get(slug)
      if (!entry) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('Review session not found. Reopen it from Orca.')
        return
      }
      if (!rest) {
        res.statusCode = 302
        res.setHeader('location', `/wt/${slug}/${parsed.search}`)
        res.end()
        return
      }

      const method = (req.method ?? 'GET').toUpperCase()
      const headers = toWebHeaders(req.headers)
      const targetUrl = new URL(`${rest}${parsed.search}`, `http://${host}`)
      let body: Uint8Array | undefined
      if (method !== 'GET' && method !== 'HEAD') {
        const buf = await readRequestBody(req)
        if (buf.length > 0)
          body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      }
      const webReq = new Request(targetUrl, {
        method,
        headers,
        body: body as BodyInit | undefined,
      })
      const response = await entry.app.fetch(webReq)
      await writeWebResponse(response, res)
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'Internal server error'
        res.statusCode = message === 'Request body too large' ? 413 : 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(message)
      } else {
        res.end()
      }
    }
  }

  async #buildWorktreeApp(
    realPath: string,
    config: ServerConfig,
  ): Promise<{ app: App; diffBase: string }> {
    const baseOpts: AppOptions = {
      cwd: realPath,
      orca: true,
      orcaBinary: config.orcaBinary || undefined,
      repositoryBrowser: true,
      tabSize: config.tabSize,
    }
    const configuredBase = config.diffBase.trim()
    if (configuredBase) {
      const app = await this.#createApp({ ...baseOpts, from: configuredBase })
      return { app, diffBase: configuredBase }
    }
    try {
      const app = await this.#createApp(baseOpts)
      return { app, diffBase: 'Auto merge-base' }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('No base revision found')) {
        const app = await this.#createApp({ ...baseOpts, revisions: 'HEAD' })
        return { app, diffBase: 'HEAD (fallback)' }
      }
      throw error
    }
  }

  async ensureMounted(target: MountTarget, config: ServerConfig): Promise<MountedSummary> {
    let realPath: string
    try {
      realPath = realpathSync(target.path)
    } catch (error) {
      throw new Error(`Workspace directory does not exist: ${target.path}`, {
        cause: error,
      })
    }

    const configKey = JSON.stringify([
      config.tabSize,
      config.diffBase.trim(),
      config.orcaBinary.trim(),
    ])
    const existing = this.#byPath.get(realPath)
    if (existing && existing.configKey === configKey && this.running) {
      existing.workspaceId = target.workspaceId
      existing.name = target.name
      existing.branch = target.branch
      return this.#summarize(existing)
    }

    const dedupeKey = `${realPath}::${configKey}`
    const pending = this.#mounting.get(dedupeKey)
    if (pending) return pending

    const work = (async () => {
      await this.#ensureServer()
      const { app, diffBase } = await this.#buildWorktreeApp(realPath, config)
      const slug = worktreeSlug(realPath)
      const entry: MountedEntry = {
        slug,
        workspaceId: target.workspaceId,
        name: target.name,
        branch: target.branch,
        path: realPath,
        app,
        diffBase,
        configKey,
        startedAt: Date.now(),
      }
      this.#byPath.set(realPath, entry)
      this.#bySlug.set(slug, entry)
      return this.#summarize(entry)
    })()

    this.#mounting.set(dedupeKey, work)
    try {
      return await work
    } finally {
      if (this.#mounting.get(dedupeKey) === work) {
        this.#mounting.delete(dedupeKey)
      }
    }
  }

  unmountPath(path: string): boolean {
    let canonical = path
    try {
      canonical = realpathSync(path)
    } catch {
      // Directory may already be deleted when workspace.removed arrives.
    }
    const entry = this.#byPath.get(canonical) ?? this.#byPath.get(path)
    if (!entry) return false
    this.#byPath.delete(entry.path)
    this.#bySlug.delete(entry.slug)
    return true
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = null
    this.#port = null
    this.#starting = null
    this.#byPath.clear()
    this.#bySlug.clear()
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }
}
