/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import * as panel from './panel.tsx'
import type { PluginState } from './protocol.ts'
import { buildBrowserOpenCommand, isLocalWorkspace } from './server.ts'
import * as workerModule from './worker.ts'

const exec = promisify(execFile)

async function createTempGitRepo(branch = 'main'): Promise<{
  tmp: string
  repo: string
  fakeOrca: string
}> {
  const tmp = await mkdtemp(join(tmpdir(), 'skepsis-orca-plugin-test-'))
  const repo = join(tmp, 'repo')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  await exec('git', ['init', '-q', '-b', branch, repo], { env })
  await writeFile(join(repo, 'hello.ts'), 'export const value = 1\n')
  await exec('git', ['add', '.'], { cwd: repo, env })
  await exec('git', ['commit', '-qm', 'initial'], { cwd: repo, env })
  await writeFile(join(repo, 'hello.ts'), 'export const value = 2\n')

  const fakeOrca = join(tmp, 'fake-orca')
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
if (args[0] === 'worktree' && args[1] === 'current') {
  reply({ worktree: { id: 'wt-1', path: process.cwd(), displayName: 'Repo Review', hostId: 'local' } });
} else if (args[0] === 'agent' && args[1] === 'list') {
  reply({ agents: [] });
} else if (args[0] === 'agent' && args[1] === 'installed') {
  reply({ agents: [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }] });
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  )

  return { tmp, repo, fakeOrca }
}

test('isLocalWorkspace allows local/null and rejects remote or WSL paths', () => {
  assert.equal(isLocalWorkspace('local', '/Users/me/repo').ok, true)
  assert.equal(isLocalWorkspace(null, '/Users/me/repo').ok, true)
  assert.equal(isLocalWorkspace('ssh:prod', '/home/me/repo').ok, false)
  assert.equal(isLocalWorkspace('runtime:dev', '/home/me/repo').ok, false)
  assert.equal(isLocalWorkspace('local', '\\\\wsl.localhost\\Ubuntu\\home\\me').ok, false)
  assert.equal(isLocalWorkspace('local', '//wsl.localhost/Ubuntu/home/me').ok, false)
})

test('buildBrowserOpenCommand passes custom opener URL as positional arg', () => {
  const custom = buildBrowserOpenCommand(
    'http://127.0.0.1:1234/wt/abc/#token=xyz',
    'open -a "Google Chrome"',
    'darwin',
  )
  assert.deepEqual(custom, {
    cmd: 'sh',
    args: [
      '-c',
      'open -a "Google Chrome" "$1"',
      'sh',
      'http://127.0.0.1:1234/wt/abc/#token=xyz',
    ],
  })
  assert.deepEqual(buildBrowserOpenCommand('http://127.0.0.1:1234/', '', 'darwin'), {
    cmd: 'open',
    args: ['http://127.0.0.1:1234/'],
  })
})

test('worker mounts local git worktree, serves Skepsis UI & Orca API, and cleans up', async () => {
  const { tmp, repo, fakeOrca } = await createTempGitRepo('main')
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'wt-1',
        branch: 'main',
        displayName: 'Repo Review',
        terminals: [],
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'wt-1',
            kind: 'worktree',
            name: 'Repo Review',
            path: repo,
            branch: 'main',
            hostId: 'local',
          },
        ],
        truncated: false,
      },
    },
    settings: {
      openCommand: 'true',
      tabSize: 4,
      diffBase: '',
      orcaBinary: fakeOrca,
    },
  })

  const worker = await mountWorker(workerModule, { host })
  try {
    // Open via command palette / status bar path (uses `true` as safe no-op opener).
    const cmdResult = await worker.command('open-review')
    assert.equal(typeof cmdResult, 'string')
    assert.match(
      String(cmdResult),
      /^Opened Skepsis review: http:\/\/127\.0\.0\.1:\d+\/wt\/[a-f0-9]{12}\/#token=/,
    )

    const status = (await worker.request('skepsis.status')) as PluginState
    assert.equal(status.running, true)
    assert.ok(status.port !== null && status.port > 0)
    assert.ok(status.currentReview)
    assert.equal(status.currentReview.diffBase, 'Auto merge-base')

    const parsed = new URL(status.currentReview.url)
    const token = new URLSearchParams(parsed.hash.slice(1)).get('token')
    assert.ok(token)

    // Missing trailing slash redirects to trailing slash.
    const noSlash = await fetch(`${parsed.origin}/wt/${status.currentReview.slug}`, {
      redirect: 'manual',
    })
    assert.equal(noSlash.status, 302)
    assert.equal(noSlash.headers.get('location'), `/wt/${status.currentReview.slug}/`)

    // Built Skepsis index.html is served under the prefix.
    const htmlRes = await fetch(`${parsed.origin}${parsed.pathname}`)
    assert.equal(htmlRes.status, 200)
    const html = await htmlRes.text()
    assert.match(html, /<!doctype html>/i)

    // API rejects missing token.
    const unauth = await fetch(`${parsed.origin}${parsed.pathname}api/diff`)
    assert.equal(unauth.status, 401)

    // API returns diff, Orca flag, and repositoryBrowser flag with token.
    const headers = { 'X-Skepsis-Token': token }
    const diffRes = await fetch(`${parsed.origin}${parsed.pathname}api/diff`, { headers })
    assert.equal(diffRes.status, 200)
    const diffJson = (await diffRes.json()) as {
      patch: string
      orca?: boolean
      repositoryBrowser?: boolean
      tabSize: number
    }
    assert.match(diffJson.patch, /-export const value = 1/)
    assert.match(diffJson.patch, /\+export const value = 2/)
    assert.equal(diffJson.orca, true)
    assert.equal(diffJson.repositoryBrowser, true)
    assert.equal(diffJson.tabSize, 4)

    // Repository files browser works.
    const filesRes = await fetch(`${parsed.origin}${parsed.pathname}api/repository-files`, {
      headers,
    })
    assert.equal(filesRes.status, 200)
    const filesJson = (await filesRes.json()) as { paths: string[]; orca: boolean }
    assert.ok(filesJson.paths.includes('hello.ts'))
    assert.equal(filesJson.orca, true)

    // Orca targets route uses the configured CLI binary.
    const orcaRes = await fetch(`${parsed.origin}${parsed.pathname}api/orca/targets`, {
      headers,
    })
    assert.equal(orcaRes.status, 200)
    const orcaJson = (await orcaRes.json()) as {
      workspace: string
      fresh: { id: string; label: string }[]
    }
    assert.equal(orcaJson.workspace, 'Repo Review')
    assert.equal(orcaJson.fresh.length, 2)

    // Removing the workspace unmounts its route cleanly.
    await worker.emit('workspace.removed', {
      workspaceId: 'wt-1',
      kind: 'worktree',
      path: repo,
    })
    const afterRemove = await fetch(`${parsed.origin}${parsed.pathname}api/diff`, {
      headers,
    })
    assert.equal(afterRemove.status, 404)

    // Status bar received updates and no host calls were refused.
    assert.ok(worker.host.callsOf('statusBar.update').length >= 2)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('worker falls back to HEAD when repo has no main/master base branch', async () => {
  const { tmp, repo, fakeOrca } = await createTempGitRepo('develop')
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'wt-dev',
        branch: 'develop',
        displayName: 'Develop WT',
        terminals: [],
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'wt-dev',
            kind: 'worktree',
            name: 'Develop WT',
            path: repo,
            branch: 'develop',
            hostId: 'local',
          },
        ],
        truncated: false,
      },
    },
    settings: {
      openCommand: '',
      tabSize: 2,
      diffBase: '',
      orcaBinary: fakeOrca,
    },
  })

  const worker = await mountWorker(workerModule, { host })
  try {
    const opened = (await worker.request('skepsis.open', {
      launchBrowser: false,
    })) as { state: PluginState; url: string; opened: boolean }
    assert.equal(opened.opened, false)
    assert.equal(opened.state.currentReview?.diffBase, 'HEAD (fallback)')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('worker rejects remote SSH workspaces without starting the server', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'wt-ssh',
        branch: 'main',
        displayName: 'Remote Box',
        terminals: [],
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'wt-ssh',
            kind: 'worktree',
            name: 'Remote Box',
            path: '/home/dev/repo',
            branch: 'main',
            hostId: 'ssh:remote-box',
          },
        ],
        truncated: false,
      },
    },
  })

  const worker = await mountWorker(workerModule, { host })
  try {
    const status = (await worker.request('skepsis.status')) as PluginState
    assert.equal(status.focused?.isLocal, false)
    await assert.rejects(
      () => worker.command('open-review'),
      /Skepsis only supports local workspaces/,
    )
    assert.equal(worker.host.callsOf('notifications.show').length, 1)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('panel opens and stops Skepsis reviews with zero errors, warnings, or refusals', async () => {
  const idleState: PluginState = {
    running: false,
    port: null,
    focused: {
      id: 'wt-1',
      name: 'feature/ui',
      branch: 'feature/ui',
      path: '/Users/dev/skepsis',
      kind: 'worktree',
      isLocal: true,
      reason: null,
    },
    currentReview: null,
    mounted: [],
    openCommand: 'open -a "Google Chrome"',
    lastError: null,
  }
  const activeState: PluginState = {
    ...idleState,
    running: true,
    port: 51234,
    currentReview: {
      slug: '1234567890ab',
      workspaceId: 'wt-1',
      name: 'feature/ui',
      branch: 'feature/ui',
      path: '/Users/dev/skepsis',
      url: 'http://127.0.0.1:51234/wt/1234567890ab/#token=abc',
      diffBase: 'Auto merge-base',
      startedAt: Date.now(),
    },
    mounted: [
      {
        slug: '1234567890ab',
        workspaceId: 'wt-1',
        name: 'feature/ui',
        branch: 'feature/ui',
        path: '/Users/dev/skepsis',
        url: 'http://127.0.0.1:51234/wt/1234567890ab/#token=abc',
        diffBase: 'Auto merge-base',
        startedAt: Date.now(),
      },
    ],
  }

  let openCalls = 0
  let stopCalls = 0
  const host = mockHost({
    requests: {
      'skepsis.status': idleState,
      'skepsis.open': () => {
        openCalls += 1
        return {
          state: activeState,
          url: activeState.currentReview!.url,
          opened: true,
        }
      },
      'skepsis.stop': () => {
        stopCalls += 1
        return idleState
      },
    },
  })

  const view = await mount(panel, { host })
  try {
    assert.ok(view.find({ text: /feature\/ui/ }))
    assert.ok(view.find({ role: 'button', text: 'Start & Open in Browser' }))

    await view.press({ role: 'button', text: 'Start & Open in Browser' })
    assert.equal(openCalls, 1)
    assert.ok(view.find({ text: /127\.0\.0\.1:51234/ }))
    assert.ok(view.find({ role: 'button', text: 'Stop Server' }))

    await view.press({ role: 'button', text: 'Stop Server' })
    assert.equal(stopCalls, 1)
    assert.ok(view.find({ role: 'button', text: 'Start & Open in Browser' }))

    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
