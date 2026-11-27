/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

const REQUEST_TIMEOUT_MS = 30_000
const STARTUP_TIMEOUT_MS = 20_000
const SSH_COMMON_ARGS = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=30',
  '-o',
  'ServerAliveCountMax=3',
]

/**
 * Lightweight stdio JSON-lines runner synced once per hash onto the remote host
 * alongside `dist/lib.js`. Runs Skepsis's git/files/symbol-definition APIs
 * directly on the remote filesystem without opening any remote TCP port, and
 * exits automatically when the SSH stdin closes.
 */
export const REMOTE_RUNNER_SOURCE = `import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// Keep stdout reserved exclusively for JSON-lines responses.
console.log = (...args) => console.error(...args)
console.info = (...args) => console.error(...args)

const libPath = process.argv[2]
if (!libPath) {
  console.error('Missing Skepsis lib path argument')
  process.exit(2)
}

const { createApp } = await import(pathToFileURL(libPath).href)
const apps = new Map()

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n')
}

async function mountWorktree(msg) {
  const baseOpts = {
    cwd: msg.cwd,
    repositoryBrowser: true,
    tabSize: typeof msg.tabSize === 'number' ? msg.tabSize : 2,
  }
  const configured = typeof msg.diffBase === 'string' ? msg.diffBase.trim() : ''
  let app
  let diffBase
  if (configured) {
    app = await createApp({ ...baseOpts, from: configured })
    diffBase = configured
  } else {
    try {
      app = await createApp(baseOpts)
      diffBase = 'Auto merge-base'
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (text.includes('No base revision found')) {
        app = await createApp({ ...baseOpts, revisions: 'HEAD' })
        diffBase = 'HEAD (fallback)'
      } else {
        throw error
      }
    }
  }
  apps.set(msg.key, app)
  return { key: msg.key, diffBase }
}

async function handleFetch(msg) {
  const app = apps.get(msg.key)
  if (!app) {
    return {
      status: 404,
      headers: [['content-type', 'application/json']],
      bodyBase64: Buffer.from(JSON.stringify({ error: 'Remote review session expired. Reopen it from Orca.' })).toString('base64'),
    }
  }
  const headers = new Headers(msg.headers || [])
  if (app.token) headers.set('X-Skepsis-Token', app.token)
  headers.set('host', '127.0.0.1')
  const method = (msg.method || 'GET').toUpperCase()
  const body =
    method !== 'GET' && method !== 'HEAD' && msg.bodyBase64
      ? Buffer.from(msg.bodyBase64, 'base64')
      : undefined
  const req = new Request(msg.url, { method, headers, body })
  const res = await app.fetch(req)
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    status: res.status,
    headers: [...res.headers.entries()],
    bodyBase64: buf.toString('base64'),
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const id = msg.id
  ;(async () => {
    try {
      if (msg.type === 'mount') {
        const result = await mountWorktree(msg)
        send({ id, ok: true, result })
      } else if (msg.type === 'unmount') {
        apps.delete(msg.key)
        send({ id, ok: true, result: { ok: true } })
      } else if (msg.type === 'fetch') {
        const result = await handleFetch(msg)
        send({ id, ok: true, result })
      } else {
        send({ id, ok: false, error: 'Unknown RPC type: ' + String(msg.type) })
      }
    } catch (error) {
      send({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})

rl.on('close', () => {
  process.exit(0)
})

send({ ready: true, nodeVersion: process.versions.node })
`

type StdioChild = ChildProcessByStdio<Writable, Readable, Readable>

export type RemoteTransportFactory = (opts: {
  sshHost: string
  remoteNode: string
}) => Promise<StdioChild>

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function sha16(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function runSshSimple(
  sshHost: string,
  remoteCmd: string,
  stdinData?: Buffer | string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_COMMON_ARGS, sshHost, remoteCmd], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (err) => {
      reject(new Error(`SSH failed for ${sshHost}: ${err.message}`, { cause: err }))
    })
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stderr: stderr.trim() })
    })
    if (stdinData !== undefined) {
      child.stdin.end(stdinData)
    } else {
      child.stdin.end()
    }
  })
}

async function syncRemoteArtifacts(
  sshHost: string,
  libBytes: Buffer,
  libFile: string,
  runnerFile: string,
): Promise<void> {
  const checkCmd = `test -f "$HOME/.cache/skepsis/${libFile}" && test -f "$HOME/.cache/skepsis/${runnerFile}"`
  const check = await runSshSimple(sshHost, checkCmd)
  if (check.code === 0) return

  // Exit code 255 from OpenSSH indicates a transport/auth failure rather than missing files.
  if (check.code === 255) {
    throw new Error(
      `Could not connect to SSH host "${sshHost}"${check.stderr ? `: ${check.stderr}` : ''}. Verify \`ssh ${sshHost}\` works without a password prompt.`,
    )
  }

  const upload = async (filename: string, content: Buffer | string) => {
    const tmp = `${filename}.tmp.$$`
    const cmd = `mkdir -p "$HOME/.cache/skepsis" && cat > "$HOME/.cache/skepsis/${tmp}" && mv "$HOME/.cache/skepsis/${tmp}" "$HOME/.cache/skepsis/${filename}"`
    const res = await runSshSimple(sshHost, cmd, content)
    if (res.code !== 0) {
      throw new Error(
        `Failed to sync Skepsis remote agent to "${sshHost}"${res.stderr ? `: ${res.stderr}` : ''}.`,
      )
    }
  }

  await upload(libFile, libBytes)
  await upload(runnerFile, REMOTE_RUNNER_SOURCE)
}

function buildRemoteStartCommand(
  libFile: string,
  runnerFile: string,
  remoteNode: string,
): string {
  const explicitNode = remoteNode.trim() ? shellQuote(remoteNode.trim()) : "''"
  return [
    `NODE_BIN=${explicitNode}`,
    'if [ -z "$NODE_BIN" ]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi',
    'if [ -z "$NODE_BIN" ]; then NODE_BIN="$(bash -lc \'command -v node\' 2>/dev/null || true)"; fi',
    'if [ -z "$NODE_BIN" ]; then for p in "$HOME/.nvm/versions/node"/*/bin/node "$HOME/.volta/bin/node" /usr/local/bin/node /opt/homebrew/bin/node; do [ -x "$p" ] && NODE_BIN="$p"; done; fi',
    'if [ -z "$NODE_BIN" ]; then echo "SKEPSIS_NODE_MISSING" >&2; exit 127; fi',
    'MAJOR="$("$NODE_BIN" -p \'process.versions.node.split(".")[0]\' 2>/dev/null || echo 0)"',
    'if [ "$MAJOR" -lt 20 ]; then echo "SKEPSIS_NODE_TOO_OLD:$("$NODE_BIN" -v 2>/dev/null)" >&2; exit 126; fi',
    `exec "$NODE_BIN" "$HOME/.cache/skepsis/${runnerFile}" "$HOME/.cache/skepsis/${libFile}"`,
  ].join('; ')
}

function defaultSshTransportFactory(): RemoteTransportFactory {
  const libPath = join(import.meta.dirname, '..', 'dist', 'lib.js')
  const libBytes = readFileSync(libPath)
  const libFile = `lib-${sha16(libBytes)}.mjs`
  const runnerFile = `runner-${sha16(REMOTE_RUNNER_SOURCE)}.mjs`

  return async ({ sshHost, remoteNode }) => {
    await syncRemoteArtifacts(sshHost, libBytes, libFile, runnerFile)
    const startCmd = buildRemoteStartCommand(libFile, runnerFile, remoteNode)
    return spawn('ssh', [...SSH_COMMON_ARGS, sshHost, startCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }
}

export class RemoteHostSession {
  readonly sshHost: string
  #child: StdioChild
  #nextId = 1
  #pending = new Map<number, PendingCall>()
  #closed = false
  #stderrTail = ''
  #onClose: () => void

  private constructor(sshHost: string, child: StdioChild, onClose: () => void) {
    this.sshHost = sshHost
    this.#child = child
    this.#onClose = onClose
  }

  get closed(): boolean {
    return this.#closed
  }

  static async connect(
    sshHost: string,
    remoteNode: string,
    factory: RemoteTransportFactory,
    onClose: () => void,
  ): Promise<RemoteHostSession> {
    const child = await factory({ sshHost, remoteNode })
    const session = new RemoteHostSession(sshHost, child, onClose)
    await session.#waitForReady()
    return session
  }

  #formatCloseError(base: string): Error {
    const stderr = this.#stderrTail.trim()
    if (stderr.includes('SKEPSIS_NODE_MISSING')) {
      return new Error(
        `Remote host "${this.sshHost}" does not have Node.js installed. Install Node.js 22+ on "${this.sshHost}" (or set "Remote Node.js Path" in plugin settings).`,
      )
    }
    const oldMatch = /SKEPSIS_NODE_TOO_OLD:([^\s]+)/.exec(stderr)
    if (oldMatch) {
      return new Error(
        `Remote host "${this.sshHost}" has Node.js ${oldMatch[1]}, but Skepsis requires Node.js 22+. Upgrade Node.js on "${this.sshHost}" or set "Remote Node.js Path" in plugin settings.`,
      )
    }
    return new Error(stderr ? `${base}: ${stderr}` : base)
  }

  #waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const rl = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })

      const finishReject = (err: Error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.close()
          reject(err)
        }
      }

      const timer = setTimeout(() => {
        finishReject(
          this.#formatCloseError(
            `Timed out starting remote Skepsis agent on "${this.sshHost}"`,
          ),
        )
      }, STARTUP_TIMEOUT_MS)

      this.#child.stderr.on('data', (chunk: Buffer) => {
        this.#stderrTail = (this.#stderrTail + chunk.toString('utf8')).slice(-2000)
      })

      rl.on('line', (line) => {
        if (!line.trim()) return
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          return
        }
        if (!settled && msg.ready === true) {
          settled = true
          clearTimeout(timer)
          resolve()
          return
        }
        const id = typeof msg.id === 'number' ? msg.id : null
        if (id === null) return
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        clearTimeout(pending.timer)
        if (msg.ok === true) {
          pending.resolve(msg.result)
        } else {
          pending.reject(
            new Error(
              typeof msg.error === 'string' ? msg.error : 'Remote agent request failed',
            ),
          )
        }
      })

      this.#child.once('error', (err) => {
        finishReject(
          new Error(`Remote connection error (${this.sshHost}): ${err.message}`, {
            cause: err,
          }),
        )
        this.#handleClosed(`Remote connection error (${this.sshHost}): ${err.message}`)
      })

      this.#child.once('close', (code) => {
        rl.close()
        const msg = `Remote Skepsis agent on "${this.sshHost}" exited (${code ?? 'signal'})`
        finishReject(this.#formatCloseError(msg))
        this.#handleClosed(msg)
      })
    })
  }

  #handleClosed(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    const err = this.#formatCloseError(reason)
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.#pending.clear()
    this.#onClose()
  }

  #call<T>(payload: Record<string, unknown>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error(`Remote session for "${this.sshHost}" is closed`))
    }
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return
        reject(new Error(`Remote request timed out on "${this.sshHost}"`))
      }, REQUEST_TIMEOUT_MS)

      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      try {
        this.#child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`)
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(
          new Error(`Failed writing to remote session "${this.sshHost}"`, { cause: error }),
        )
      }
    })
  }

  async mountWorktree(opts: {
    key: string
    cwd: string
    tabSize: number
    diffBase: string
  }): Promise<{ key: string; diffBase: string }> {
    return this.#call<{ key: string; diffBase: string }>({
      type: 'mount',
      ...opts,
    })
  }

  async unmountWorktree(key: string): Promise<void> {
    if (this.#closed) return
    await this.#call({ type: 'unmount', key }).catch(() => {})
  }

  async fetchWorktree(key: string, request: Request): Promise<Response> {
    const method = request.method.toUpperCase()
    let bodyBase64: string | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const buf = Buffer.from(await request.arrayBuffer())
      if (buf.length > 0) bodyBase64 = buf.toString('base64')
    }
    const result = await this.#call<{
      status: number
      headers: [string, string][]
      bodyBase64: string
    }>({
      type: 'fetch',
      key,
      url: request.url,
      method,
      headers: [...request.headers.entries()],
      bodyBase64,
    })
    const body = result.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64') : null
    return new Response(body, {
      status: result.status,
      headers: result.headers,
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`Remote session for "${this.sshHost}" stopped`))
    }
    this.#pending.clear()
    try {
      this.#child.stdin.end()
    } catch {
      // Ignore already-closed stdin.
    }
    this.#child.kill()
    this.#onClose()
  }
}

export class RemoteSessionPool {
  #sessions = new Map<string, RemoteHostSession>()
  #connecting = new Map<string, Promise<RemoteHostSession>>()
  #factory: RemoteTransportFactory | null

  constructor(factory?: RemoteTransportFactory) {
    this.#factory = factory ?? null
  }

  #getFactory(): RemoteTransportFactory {
    return (this.#factory ??= defaultSshTransportFactory())
  }

  async getSession(
    sshHost: string,
    remoteNode: string,
    onDisconnect: () => void,
  ): Promise<RemoteHostSession> {
    const existing = this.#sessions.get(sshHost)
    if (existing && !existing.closed) return existing

    const inflight = this.#connecting.get(sshHost)
    if (inflight) return inflight

    const work = RemoteHostSession.connect(sshHost, remoteNode, this.#getFactory(), () => {
      if (this.#sessions.get(sshHost) === sessionRef) {
        this.#sessions.delete(sshHost)
      }
      onDisconnect()
    })
    let sessionRef: RemoteHostSession | null = null
    this.#connecting.set(sshHost, work)
    try {
      sessionRef = await work
      this.#sessions.set(sshHost, sessionRef)
      return sessionRef
    } finally {
      if (this.#connecting.get(sshHost) === work) {
        this.#connecting.delete(sshHost)
      }
    }
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) {
      session.close()
    }
    this.#sessions.clear()
    this.#connecting.clear()
  }
}
