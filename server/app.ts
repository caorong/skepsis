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
import { basename, join } from 'node:path'
import type { DiffArgs } from '../shared/types.ts'
import { repoRoot } from './diffSource.ts'
import { createRepositoryFiles, sourceLines } from './repositoryFiles.ts'
import { resolveSymbolDefinitions } from './symbolDefinition.ts'
import { getDiff, patchHash } from './diff.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { getGeneratedFiles } from './generated.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { insertComment, removeComment } from './comment.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import { newToken, sendGate, tokenMatches } from './gate.ts'
import { buildPayload, renderPrompt } from './send.ts'
import type { OrcaBridge } from './orca.ts'
import type { SendPayload, SendResult } from './send.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentRequestSchema,
  commentDeleteSchema,
  sendRequestSchema,
  orcaRequestSchema,
  repositoryReviewSchema,
  fileContentsQuerySchema,
  symbolDefinitionsQuerySchema,
  themeRequestSchema,
  DEFAULT_TAB_SIZE,
  TOKEN_HEADER,
} from '../shared/types.ts'
import type {
  DiffHashResponse,
  DiffResponse,
  RepositoryFilesResponse,
  FileContentsResponse,
  OkResponse,
  ErrorResponse,
  ThemeResponse,
} from '../shared/types.ts'

export interface BuildOptions {
  diffSource: DiffArgs
  /** Absolute. Where jj/git run, and what comment and file paths are relative to */
  cwd: string
  /** Serve /api/diff-hash for the page's change polling. Default true. */
  poll?: boolean
  /** Delivers a comment the page sends. Unset, /api/send doesn't exist and
   *  the page has no Send button. */
  send?: ((payload: SendPayload) => Promise<SendResult>) | null
  orca?: OrcaBridge
  /** Only the local CLI opts into browsing beyond the configured diff. */
  repositoryBrowser?: boolean
  /** Default true: API requests need the per-run token, and /api/send needs
   *  a loopback Host and a matching Origin. False when a host application
   *  checks requests before they get here */
  guard?: boolean
  /** Tab width in columns (default: DEFAULT_TAB_SIZE) */
  tabSize?: number
}

/** A fetch handler for the page and its API, rooted at `/` */
export interface App {
  fetch(request: Request): Response | Promise<Response>
  /** The value API requests must send in the token header, or null when
   *  `guard` is false */
  token: string | null
}

/** The page and its API for one diff. Runs the diff once and rejects if it
 *  fails. */
export async function buildApp(opts: BuildOptions): Promise<App> {
  const {
    diffSource,
    cwd,
    poll = true,
    send,
    orca,
    guard = true,
    repositoryBrowser = false,
  } = opts
  const { tabSize = DEFAULT_TAB_SIZE } = opts
  // The paths in the latest diff, including the old names of renames. A
  // request's path is joined onto the repo directory, so the routes that read
  // or write files only take one of these: `../` could otherwise reach
  // anything the process can.
  let diffFiles = new Set<string>()
  const runDiff = async () => {
    const diff = await getDiff(diffSource, cwd)
    const renamedFrom = [...diff.patch.matchAll(/^rename from (.+)$/gm)].map((m) => m[1]!)
    diffFiles = new Set([...Object.keys(diff.fileHashes), ...renamedFrom])
    return diff
  }
  /** Throws unless `file` is in the diff, running it again first if the last
   *  one didn't have it */
  const requireInDiff = async (file: string) => {
    if (diffFiles.has(file)) return
    await runDiff()
    if (!diffFiles.has(file))
      throw new HTTPException(400, { message: `Not a file in this diff: ${file}` })
  }

  // Fail fast on bad args by running the exact diff command we'll serve.
  // /api/diff re-runs it per request to stay fresh.
  await runDiff()

  const app = new Hono()
  const token = guard ? newToken() : null

  // Every API call must carry the token (see tokenMatches). The theme boot
  // script is the exception: a <script src> can't send a header, and all it
  // gives away is the theme.
  app.use('/api/*', async (c, next) => {
    if (
      token === null ||
      c.req.path === '/api/theme.js' ||
      tokenMatches(c.req.header(TOKEN_HEADER), token)
    )
      return next()
    return c.json(
      {
        error:
          'This page has no valid token. Open the URL skepsis printed when it started.',
      } satisfies ErrorResponse,
      401,
    )
  })

  // An interdiff that ends at the working copy still can't take comments: a
  // changed description shows as a file named JJ-COMMIT-DESCRIPTION, which a
  // comment would create on disk.
  const commentsEnabled = diffSource.toWorkingCopy && !diffSource.interdiff

  app.get('/api/diff', async (c) => {
    const { patch, fileHashes } = await runDiff()
    const files = Object.keys(fileHashes)
    const [viewed, generated, commentSyntaxes] = await Promise.all([
      loadViewed(cwd, fileHashes),
      getGeneratedFiles(cwd, files),
      commentsEnabled ? getCommentSyntaxes(cwd, files) : {},
    ])
    return c.json({
      patch,
      revset: displayCommand(diffSource),
      repo: basename(cwd),
      vcs: diffSource.vcs,
      interdiff: !!diffSource.interdiff,
      commentsEnabled,
      expandable: diffSource.endpoints !== null,
      fileHashes,
      patchHash: patchHash(patch),
      poll,
      send: !!send || !!orca,
      ...(orca ? { orca: true } : {}),
      ...(repositoryBrowser && guard ? { repositoryBrowser: true } : {}),
      tabSize,
      viewed,
      commentSyntaxes,
      generated,
    } satisfies DiffResponse)
  })

  // Polled every few seconds while the page is visible. Requests that arrive
  // while a diff is running share its result rather than starting another, so
  // several tabs, or a diff slower than the interval, never pile up. /api/diff
  // doesn't share: it follows the page's own edits (a comment), and a poll
  // that started before the edit would hand back the old patch. For the same
  // reason, an edit stops later polls from sharing a diff already running.
  let hashInFlight: Promise<string> | null = null
  app.get('/api/diff-hash', async (c) => {
    if (!poll)
      return c.json({ error: 'polling is off (--no-poll)' } satisfies ErrorResponse, 404)
    if (!hashInFlight) {
      const run = runDiff()
        .then(({ patch }) => patchHash(patch))
        .finally(() => {
          if (hashInFlight === run) hashInFlight = null
        })
      hashInFlight = run
    }
    return c.json({ hash: await hashInFlight } satisfies DiffHashResponse)
  })

  app.get('/api/file-contents', zValidator('query', fileContentsQuerySchema), async (c) => {
    const { path, oldPath } = c.req.valid('query')
    await requireInDiff(path)
    if (oldPath) await requireInDiff(oldPath)
    const contents = await getFileContents(diffSource, cwd, path, oldPath)
    return c.json(contents satisfies FileContentsResponse)
  })

  app.post('/api/viewed', zValidator('json', viewedRequestSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await markViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed', zValidator('json', viewedDeleteSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await unmarkViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed-all', zValidator('json', viewedDeleteAllSchema), async (c) => {
    const { files } = c.req.valid('json')
    await unmarkViewedAll(cwd, files)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.post('/api/comment', zValidator('json', commentRequestSchema), async (c) => {
    const { file, afterLine, lineText, text, lineCount, quote } = c.req.valid('json')
    await requireInDiff(file)
    await insertComment(cwd, file, afterLine, lineText, text, lineCount, quote)
    hashInFlight = null
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Calls `send`, which for the CLI runs a command, so only the page may call
  // it (see gate.ts). Sends run one at a time in arrival order, so two quick
  // ones can't reach the far end swapped.
  let sendQueue: Promise<SendResult> = Promise.resolve({ ok: true, output: '' })
  if (send) {
    app.post(
      '/api/send',
      async (c, next) => {
        const headers = {
          host: c.req.header('host'),
          origin: c.req.header('origin'),
        }
        if (guard && !sendGate(headers))
          return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
        await next()
      },
      zValidator('json', sendRequestSchema),
      async (c) => {
        // The blob comes from the page with the lines and excerpt, so all
        // three describe the version on screen even if the file has changed
        // since. Nothing here awaits, so sends join the queue as they arrive.
        const payload = buildPayload(diffSource, cwd, c.req.valid('json'))
        const run = () => send(payload)
        const result = sendQueue.then(run, run)
        sendQueue = result
        const r = await result
        if (!r.ok) return c.json({ error: r.error } satisfies ErrorResponse, 502)
        return c.json({ ok: true } satisfies OkResponse)
      },
    )
  }

  if (orca && guard) {
    app.use('/api/orca/*', async (c, next) => {
      if (!sendGate({ host: c.req.header('host'), origin: c.req.header('origin') }))
        return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
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
      if (!input.file || !input.lines || !input.side)
        return c.json(
          { error: 'Select lines in the diff first.' } satisfies ErrorResponse,
          400,
        )
      await requireInDiff(input.file)
      try {
        return c.json(await orca.deliver(target, buildPayload(diffSource, cwd, input)))
      } catch (error) {
        return c.json({ error: (error as Error).message } satisfies ErrorResponse, 502)
      }
    })
  }

  // File review is explicit and independent of the currently selected diff range.
  let repo: ReturnType<typeof createRepositoryFiles> | undefined
  const repository = () =>
    (repo ??= createRepositoryFiles(repoRoot(cwd, diffSource.vcs), diffSource.vcs))
  if (repositoryBrowser && guard) {
    app.get('/api/repository-files', async (c) =>
      c.json({
        paths: await repository().paths(),
        send: !!send || (!!orca && guard),
        orca: !!orca && guard,
        tabSize,
      } satisfies RepositoryFilesResponse),
    )
    app.get('/api/repository-file', async (c) => {
      const file = c.req.query('path')
      if (!file || file.length > 4096)
        throw new HTTPException(400, { message: 'Choose a file.' })
      return c.json(await repository().read(file))
    })
    app.get(
      '/api/symbol-definitions',
      zValidator('query', symbolDefinitionsQuerySchema),
      async (c) => {
        const { symbol, fromFile, receiver, isCall, line } = c.req.valid('query')
        return c.json(
          await resolveSymbolDefinitions({
            root: repository().root,
            symbol,
            fromFile,
            receiver,
            isCall: isCall === '1',
            line,
            paths: repository().paths,
            read: repository().read,
          }),
        )
      },
    )
    if (send || (orca && guard)) {
      app.post(
        '/api/repository-review',
        async (c, next) => {
          if (
            guard &&
            !sendGate({ host: c.req.header('host'), origin: c.req.header('origin') })
          )
            return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
          await next()
        },
        zValidator('json', repositoryReviewSchema),
        async (c) => {
          const request = c.req.valid('json')
          if ((request.target && !(orca && guard)) || (!request.target && !send))
            throw new HTTPException(400, {
              message: 'Choose an enabled review destination.',
            })
          const file = await repository().read(request.path)
          if (file.revision !== request.revision)
            throw new HTTPException(409, {
              message: 'File changed on disk. Refresh the file before sending.',
            })
          const lines = sourceLines(file.contents)
          const [first, last] = request.lines
          if (last < first || last > lines.length)
            throw new HTTPException(400, { message: 'Select a valid line range.' })
          if (last - first >= 200)
            throw new HTTPException(400, { message: 'Select at most 200 lines.' })
          const from = Math.max(1, first - 3)
          const to = Math.min(lines.length, last + 3)
          const excerpt = lines.slice(from - 1, to).join('\n')
          if (Buffer.byteLength(excerpt) > 32_000)
            throw new HTTPException(413, {
              message: 'The selected code is too large to send. Select fewer lines.',
            })
          const base = {
            version: 1 as const,
            root: repository().root,
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
            if (request.target && orca)
              return c.json(await orca.deliver(request.target, payload))
            const run = () => send!(payload)
            const pending = sendQueue.then(run, run)
            sendQueue = pending
            const result = await pending
            if (!result.ok)
              return c.json({ error: result.error } satisfies ErrorResponse, 502)
            return c.json({ status: 'Sent' })
          } catch (error) {
            return c.json({ error: (error as Error).message } satisfies ErrorResponse, 502)
          }
        },
      )
    }
  }

  app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
    const { file, line } = c.req.valid('json')
    await requireInDiff(file)
    await removeComment(cwd, file, line)
    hashInFlight = null
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.get('/api/theme', async (c) => {
    return c.json({ theme: await loadTheme() } satisfies ThemeResponse)
  })

  // Loaded by a render-blocking <script> in index.html (see themeBootScript).
  // no-store: a cached copy would re-apply an old preference before React
  // corrects it, flashing the wrong theme — the exact problem this solves.
  app.get('/api/theme.js', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'text/javascript')
    return c.body(themeBootScript(await loadTheme()))
  })

  app.post('/api/theme', zValidator('json', themeRequestSchema), async (c) => {
    await saveTheme(c.req.valid('json').theme)
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Keep this path valid from source (`server/`) and from the published
  // bundles (`dist/cli.js`, `dist/lib.js`): all are one directory below the
  // package root.
  const distDir = join(import.meta.dirname, '..', 'dist', 'web')

  // No fallback to index.html for other paths: the page's URLs are relative,
  // so it would load nothing from below the root.
  app.use('*', serveStatic({ root: distDir }))

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500
    return c.json({ error: err.message } satisfies ErrorResponse, status)
  })

  return { fetch: app.fetch, token }
}
