/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { TOKEN_HEADER } from './shared/types.ts'
import type {
  DiffResponse,
  ErrorResponse,
  FileContentsResponse,
  OrcaTargetsResponse,
  RepositoryFilesResponse,
} from './shared/types.ts'
import type { App, SendPayload } from './lib.ts'
import { isolateVcsConfig, run } from './server/testUtil.ts'

// See server/main.test.ts: HOME must be isolated before the server loads.
const home = await isolateVcsConfig()
const { createApp, createRemoteProxyApp } = await import('./lib.ts')

let tmp: string
/** A git repo with sub/f.txt changed from "before" to "after" in the working tree */
let repo: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'skepsis-lib-test-'))
  repo = join(tmp, 'repo')
  await run('git', ['init', '-q', repo], tmp)
  await mkdir(join(repo, 'sub'))
  await writeFile(join(repo, 'sub', 'f.txt'), 'before\n')
  await run('git', ['add', '.'], repo)
  await run('git', ['commit', '-qm', 'init'], repo)
  await writeFile(join(repo, 'sub', 'f.txt'), 'after\n')
})

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

const get = (app: App, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://example.ts.net${path}`, { headers }))

it('serves the diff the revision options select, behind the token', async () => {
  const app = await createApp({ cwd: repo, revisions: 'HEAD' })
  expect((await get(app, '/api/diff')).status).toBe(401)

  const headers = { [TOKEN_HEADER]: app.token! }
  const diff = (await (await get(app, '/api/diff', headers)).json()) as DiffResponse
  expect(diff.vcs).toBe('git')
  expect(diff.revset).toBe('git diff HEAD')
  expect(diff.patch).toContain('-before\n+after')
  expect(diff.send).toBe(false)
  const contents = await get(app, '/api/file-contents?path=sub/f.txt', headers)
  expect((await contents.json()) as FileContentsResponse).toEqual({
    oldContents: 'before\n',
    newContents: 'after\n',
  })
})

it('rejects a cwd below the repository root', async () => {
  await expect(createApp({ cwd: join(repo, 'sub'), revisions: 'HEAD' })).rejects.toThrow(
    /cwd must be the root of the git repository/,
  )
})

it('rejects what the CLI refuses', async () => {
  await expect(createApp({ cwd: repo, interdiff: true, from: 'HEAD' })).rejects.toThrow(
    '--interdiff needs jj',
  )
  await expect(createApp({ cwd: tmp })).rejects.toThrow('Not in a jj or git repository')
})

it('calls send with the payload, and reports a throw as the error', async () => {
  const got: SendPayload[] = []
  const app = await createApp({
    cwd: repo,
    revisions: 'HEAD',
    guard: false,
    send: (payload) => {
      if (payload.text === 'fail') throw new Error('no agent')
      got.push(payload)
    },
  })
  expect(app.token).toBeNull()
  const send = (text: string) =>
    app.fetch(
      new Request('https://example.ts.net/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: null,
          side: null,
          lines: null,
          columns: null,
          code: null,
          blob: null,
          text,
        }),
      }),
    )
  expect((await send('hello')).status).toBe(200)
  expect(got).toMatchObject([{ root: repo, text: 'hello', prompt: expect.any(String) }])
  const failed = await send('fail')
  expect(failed.status).toBe(502)
  expect(((await failed.json()) as ErrorResponse).error).toBe('no agent')
})

it('supports orca and repositoryBrowser options with guard enabled', async () => {
  await expect(
    createApp({ cwd: repo, revisions: 'HEAD', orca: true, send: () => {} }),
  ).rejects.toThrow('Choose either orca or send, not both.')
  await expect(
    createApp({ cwd: repo, revisions: 'HEAD', orca: true, guard: false }),
  ).rejects.toThrow('orca requires guard: true')

  const bin = join(tmp, 'fake-orca')
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
if (args[0] === 'worktree' && args[1] === 'current') {
  reply({ worktree: { id: 'wt-1', path: process.cwd(), displayName: 'Test WT', hostId: 'local' } });
} else if (args[0] === 'agent' && args[1] === 'list') {
  reply({ agents: [] });
} else if (args[0] === 'agent' && args[1] === 'installed') {
  reply({ agents: [{ id: 'codex', name: 'Codex' }] });
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  )

  const app = await createApp({
    cwd: repo,
    revisions: 'HEAD',
    orca: true,
    orcaBinary: bin,
    repositoryBrowser: true,
  })
  const headers = { [TOKEN_HEADER]: app.token!, host: '127.0.0.1:4321' }
  const diff = (await (
    await app.fetch(new Request('http://127.0.0.1:4321/api/diff', { headers }))
  ).json()) as DiffResponse
  expect(diff.orca).toBe(true)
  expect(diff.repositoryBrowser).toBe(true)
  expect(diff.send).toBe(true)

  const files = (await (
    await app.fetch(new Request('http://127.0.0.1:4321/api/repository-files', { headers }))
  ).json()) as RepositoryFilesResponse
  expect(files.paths).toContain('sub/f.txt')
  expect(files.orca).toBe(true)

  const targets = (await (
    await app.fetch(new Request('http://127.0.0.1:4321/api/orca/targets', { headers }))
  ).json()) as OrcaTargetsResponse
  expect(targets.workspace).toBe('Test WT')
  expect(targets.fresh).toEqual([{ id: 'codex', label: 'Codex' }])
})

it('createRemoteProxyApp proxies data APIs and routes Orca delivery via --environment', async () => {
  const remoteApp = await createApp({
    cwd: repo,
    revisions: 'HEAD',
    repositoryBrowser: true,
  })
  const remoteRoot = '/remote/orderly-voucher-calc'

  const bin = join(tmp, 'fake-remote-orca')
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
if (args[0] !== '--environment' || args[1] !== 'orderlyClaw2') {
  console.log(JSON.stringify({ ok: false, error: { code: 'missing_env' } }));
  process.exit(1);
}
const rest = args.slice(2);
if (rest[0] === 'worktree' && rest[1] === 'show' && rest[3] === 'path:${remoteRoot}') {
  reply({ worktree: { id: 'repo-1::${remoteRoot}', path: '${remoteRoot}', displayName: 'Remote Voucher', hostId: 'local' } });
} else if (rest[0] === 'agent' && rest[1] === 'list') {
  reply({ agents: [] });
} else if (rest[0] === 'agent' && rest[1] === 'installed') {
  reply({ agents: [{ id: 'codex', name: 'Codex' }] });
} else if (rest[0] === 'agent' && rest[1] === 'launch') {
  reply({ worktreeId: 'repo-1::${remoteRoot}', outcome: { kind: 'structured' }, prompt: { outcome: 'journaled' } });
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  )

  const proxy = createRemoteProxyApp({
    remoteRoot,
    remoteFetch: (req) => {
      const headers = new Headers(req.headers)
      if (remoteApp.token) headers.set(TOKEN_HEADER, remoteApp.token)
      return Promise.resolve(remoteApp.fetch(new Request(req, { headers })))
    },
    orca: { environment: 'orderlyClaw2', expectedHostId: 'local', binary: bin },
  })

  expect((await proxy.fetch(new Request('http://127.0.0.1:4321/api/diff'))).status).toBe(
    401,
  )

  const headers = {
    [TOKEN_HEADER]: proxy.token!,
    host: '127.0.0.1:4321',
    origin: 'http://127.0.0.1:4321',
  }
  const diff = (await (
    await proxy.fetch(new Request('http://127.0.0.1:4321/api/diff', { headers }))
  ).json()) as DiffResponse
  expect(diff.orca).toBe(true)
  expect(diff.send).toBe(true)
  expect(diff.repositoryBrowser).toBe(true)
  expect(diff.patch).toContain('-before\n+after')

  const targets = (await (
    await proxy.fetch(new Request('http://127.0.0.1:4321/api/orca/targets', { headers }))
  ).json()) as OrcaTargetsResponse
  expect(targets.workspace).toBe('Remote Voucher')
  expect(targets.fresh).toEqual([{ id: 'codex', label: 'Codex' }])

  // Sending from Diff view works and checks Origin gate.
  expect(
    (
      await proxy.fetch(
        new Request('http://127.0.0.1:4321/api/orca/send', {
          method: 'POST',
          headers: {
            ...headers,
            origin: 'https://evil.example',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            target: { kind: 'new', id: 'codex' },
            file: 'sub/f.txt',
            side: 'additions',
            lines: [1, 1],
            columns: null,
            code: null,
            blob: null,
            text: 'Check this',
          }),
        }),
      )
    ).status,
  ).toBe(403)

  const diffSend = await proxy.fetch(
    new Request('http://127.0.0.1:4321/api/orca/send', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'new', id: 'codex' },
        file: 'sub/f.txt',
        side: 'additions',
        lines: [1, 1],
        columns: null,
        code: null,
        blob: null,
        text: 'Check this diff line',
      }),
    }),
  )
  expect(diffSend.status).toBe(200)
  expect(await diffSend.json()).toEqual({ status: 'Started in Orca' })

  // Sending from Files view fetches remote snapshot and delivers to remote Orca agent.
  const fileSnap = (await (
    await proxy.fetch(
      new Request('http://127.0.0.1:4321/api/repository-file?path=sub/f.txt', { headers }),
    )
  ).json()) as { path: string; revision: string }
  const fileSend = await proxy.fetch(
    new Request('http://127.0.0.1:4321/api/repository-review', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        path: fileSnap.path,
        revision: fileSnap.revision,
        lines: [1, 1],
        text: 'Check this full-file line',
        target: { kind: 'new', id: 'codex' },
      }),
    }),
  )
  expect(fileSend.status).toBe(200)
  expect(await fileSend.json()).toEqual({ status: 'Started in Orca' })
})
