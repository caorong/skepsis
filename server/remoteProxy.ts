/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { join } from 'node:path'
import type { App } from './app.ts'
import { newToken, sendGate, tokenMatches } from './gate.ts'
import { createOrcaBridge, orcaRunner } from './orca.ts'
import { sourceLines } from './repositoryFiles.ts'
import { renderPrompt } from './send.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import {
  orcaRequestSchema,
  repositoryReviewSchema,
  themeRequestSchema,
  TOKEN_HEADER,
} from '../shared/types.ts'
import type {
  DiffResponse,
  ErrorResponse,
  OkResponse,
  RepositoryFile,
  RepositoryFilesResponse,
  ThemeResponse,
} from '../shared/types.ts'

export interface RemoteProxyOptions {
  /** Absolute repository root path on the remote machine. */
  remoteRoot: string
  /** Forward a request (path starting with `/api/...`) to the remote Skepsis
   *  API instance. The caller injects any transport auth/routing headers. */
  remoteFetch: (request: Request) => Promise<Response>
  /** Optional local Orca bridge targeting the remote workspace via desktop CLI. */
  orca?: {
    environment?: string
    expectedHostId?: string
    binary?: string
  }
}

/**
 * Local proxy `App` for a remote git/jj worktree: serves static web assets and
 * theme settings directly from the local machine, routes `/api/orca/*` and
 * Files-tab review delivery through the local Orca CLI (`--environment`), and
 * forwards diff/file/symbol/comment APIs to the lightweight remote API agent.
 */
export function buildRemoteProxyApp(opts: RemoteProxyOptions): App {
  const { remoteRoot, remoteFetch } = opts
  const orca = opts.orca
    ? createOrcaBridge(
        remoteRoot,
        orcaRunner(remoteRoot, {
          binary: opts.orca.binary,
          environment: opts.orca.environment,
        }),
        { expectedHostId: opts.orca.expectedHostId ?? 'local' },
      )
    : undefined

  const app = new Hono()
  const token = newToken()

  let diffMeta: {
    command: string
    toWorkingCopy: boolean
    files: Set<string>
  } = {
    command: 'Working tree',
    toWorkingCopy: true,
    files: new Set(),
  }

  const forward = async (req: Request, pathAndQuery?: string): Promise<Response> => {
    const incomingUrl = new URL(req.url)
    const target = new URL(
      pathAndQuery ?? `${incomingUrl.pathname}${incomingUrl.search}`,
      'http://127.0.0.1',
    )
    const headers = new Headers(req.headers)
    headers.delete(TOKEN_HEADER)
    headers.delete('host')
    const method = req.method.toUpperCase()
    const body = method === 'GET' || method === 'HEAD' ? undefined : await req.arrayBuffer()
    return remoteFetch(
      new Request(target, {
        method,
        headers,
        body: body && body.byteLength > 0 ? body : undefined,
      }),
    )
  }

  const refreshDiffMeta = async () => {
    const res = await remoteFetch(new Request('http://127.0.0.1/api/diff'))
    if (!res.ok) return
    const data = (await res.json()) as DiffResponse
    const renamedFrom = [...data.patch.matchAll(/^rename from (.+)$/gm)].map((m) => m[1]!)
    diffMeta = {
      command: data.revset,
      toWorkingCopy: data.commentsEnabled,
      files: new Set([...Object.keys(data.fileHashes), ...renamedFrom]),
    }
  }

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/theme.js' || tokenMatches(c.req.header(TOKEN_HEADER), token)) {
      return next()
    }
    return c.json(
      {
        error:
          'This page has no valid token. Open the URL skepsis printed when it started.',
      } satisfies ErrorResponse,
      401,
    )
  })

  // Theme stays local to the reviewer's desktop machine.
  app.get('/api/theme', async (c) => {
    return c.json({ theme: await loadTheme() } satisfies ThemeResponse)
  })
  app.get('/api/theme.js', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'text/javascript')
    return c.body(themeBootScript(await loadTheme()))
  })
  app.post('/api/theme', zValidator('json', themeRequestSchema), async (c) => {
    await saveTheme(c.req.valid('json').theme)
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Inject local Orca capability flags onto remote diff / repository-files responses.
  app.get('/api/diff', async (c) => {
    const res = await forward(c.req.raw)
    if (!res.ok) return res
    const data = (await res.json()) as DiffResponse
    const renamedFrom = [...data.patch.matchAll(/^rename from (.+)$/gm)].map((m) => m[1]!)
    diffMeta = {
      command: data.revset,
      toWorkingCopy: data.commentsEnabled,
      files: new Set([...Object.keys(data.fileHashes), ...renamedFrom]),
    }
    return c.json({
      ...data,
      send: !!orca || data.send,
      ...(orca ? { orca: true } : {}),
    } satisfies DiffResponse)
  })

  app.get('/api/repository-files', async (c) => {
    const res = await forward(c.req.raw)
    if (!res.ok) return res
    const data = (await res.json()) as RepositoryFilesResponse
    return c.json({
      ...data,
      send: !!orca || data.send,
      orca: !!orca || data.orca,
    } satisfies RepositoryFilesResponse)
  })

  if (orca) {
    app.use('/api/orca/*', async (c, next) => {
      if (!sendGate({ host: c.req.header('host'), origin: c.req.header('origin') })) {
        return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
      }
      await next()
    })

    app.get('/api/orca/targets', async (c) => {
      try {
        return c.json(await orca.targets())
      } catch (error) {
        return c.json({ error: (error as Error).message } satisfies ErrorResponse, 502)
      }
    })

    app.post('/api/orca/send', zValidator('json', orcaRequestSchema), async (c) => {
      const { target, ...input } = c.req.valid('json')
      if (!input.file || !input.lines || !input.side) {
        return c.json(
          { error: 'Select lines in the diff first.' } satisfies ErrorResponse,
          400,
        )
      }
      if (!diffMeta.files.has(input.file)) {
        await refreshDiffMeta()
        if (!diffMeta.files.has(input.file)) {
          return c.json(
            { error: `Not a file in this diff: ${input.file}` } satisfies ErrorResponse,
            400,
          )
        }
      }
      const base = {
        version: 1 as const,
        root: remoteRoot,
        diff: { command: diffMeta.command, toWorkingCopy: diffMeta.toWorkingCopy },
        ...input,
      }
      const payload = { ...base, prompt: renderPrompt(base) }
      try {
        return c.json(await orca.deliver(target, payload))
      } catch (error) {
        return c.json({ error: (error as Error).message } satisfies ErrorResponse, 502)
      }
    })

    app.post(
      '/api/repository-review',
      async (c, next) => {
        if (!sendGate({ host: c.req.header('host'), origin: c.req.header('origin') })) {
          return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
        }
        await next()
      },
      zValidator('json', repositoryReviewSchema),
      async (c) => {
        const request = c.req.valid('json')
        if (!request.target) {
          throw new HTTPException(400, {
            message: 'Choose an enabled review destination.',
          })
        }
        const fileRes = await remoteFetch(
          new Request(
            `http://127.0.0.1/api/repository-file?${new URLSearchParams({ path: request.path })}`,
          ),
        )
        if (!fileRes.ok) return fileRes
        const file = (await fileRes.json()) as RepositoryFile
        if (file.revision !== request.revision) {
          throw new HTTPException(409, {
            message: 'File changed on disk. Refresh the file before sending.',
          })
        }
        const lines = sourceLines(file.contents)
        const [first, last] = request.lines
        if (last < first || last > lines.length) {
          throw new HTTPException(400, { message: 'Select a valid line range.' })
        }
        if (last - first >= 200) {
          throw new HTTPException(400, { message: 'Select at most 200 lines.' })
        }
        const from = Math.max(1, first - 3)
        const to = Math.min(lines.length, last + 3)
        const excerpt = lines.slice(from - 1, to).join('\n')
        if (Buffer.byteLength(excerpt) > 32_000) {
          throw new HTTPException(413, {
            message: 'The selected code is too large to send. Select fewer lines.',
          })
        }
        const base = {
          version: 1 as const,
          root: remoteRoot,
          diff: { command: 'Working tree', toWorkingCopy: true },
          scope: 'working-tree' as const,
          file: file.path,
          side: 'additions' as const,
          lines: request.lines,
          columns: null,
          code: [{ lines: [from, to] as [number, number], text: excerpt }],
          blob: null,
          text: request.text,
        }
        const payload = { ...base, prompt: renderPrompt(base) }
        try {
          return c.json(await orca.deliver(request.target, payload))
        } catch (error) {
          return c.json({ error: (error as Error).message } satisfies ErrorResponse, 502)
        }
      },
    )
  }

  // Forward all remaining API routes (diff-hash, file-contents, viewed, comment,
  // repository-file, symbol-definitions) to the remote agent.
  app.all('/api/*', async (c) => forward(c.req.raw))

  // Serve built web UI directly from the local machine (zero remote transfer).
  const distDir = join(import.meta.dirname, '..', 'dist', 'web')
  app.use('*', serveStatic({ root: distDir }))

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500
    return c.json({ error: err.message } satisfies ErrorResponse, status)
  })

  return { fetch: app.fetch, token }
}
