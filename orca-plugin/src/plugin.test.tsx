/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import * as panel from './panel.tsx'
import type { PluginState } from './protocol.ts'
import { REMOTE_RUNNER_SOURCE } from './remoteBridge.ts'
import { parseSshHostMap, resolveWorkspaceHost } from './remoteHost.ts'
import { buildBrowserOpenCommand, isLocalWorkspace } from './server.ts'
import * as workerModule from './worker.ts'
import { activateWithDeps } from './worker.ts'

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
  await writeFile(
    join(repo, 'hello.ts'),
    'export function computeTotal(x: number) {\n  return x + 1\n}\n',
  )
  await exec('git', ['add', '.'], { cwd: repo, env })
  await exec('git', ['commit', '-qm', 'initial'], { cwd: repo, env })
  await writeFile(
    join(repo, 'hello.ts'),
    'export function computeTotal(x: number) {\n  return x + 2\n}\n',
  )

  const fakeOrca = join(tmp, 'fake-orca')
  await writeFile(
    fakeOrca,
    `#!/usr/bin/env node
const raw = process.argv.slice(2);
let envName = null;
let args = raw;
if (raw[0] === '--environment') {
  envName = raw[1];
  args = raw.slice(2);
}
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
if (args[0] === 'worktree' && args[1] === 'current') {
  reply({ worktree: { id: 'wt-1', path: process.cwd(), displayName: 'Repo Review', hostId: 'local' } });
} else if (args[0] === 'worktree' && args[1] === 'show') {
  const selector = args[3] || '';
  const wtPath = selector.startsWith('path:') ? selector.slice(5) : process.cwd();
  reply({ worktree: { id: 'remote-wt-1', path: wtPath, displayName: 'Remote ' + (envName || 'ssh'), hostId: 'local' } });
} else if (args[0] === 'agent' && args[1] === 'list') {
  reply({ agents: [] });
} else if (args[0] === 'agent' && args[1] === 'installed') {
  reply({ agents: [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }] });
} else if (args[0] === 'agent' && args[1] === 'launch') {
  reply({ worktreeId: 'remote-wt-1', outcome: { kind: 'structured' }, prompt: { outcome: 'journaled' } });
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

test('parseSshHostMap and resolveWorkspaceHost handle local, runtime, ssh, overrides, and WSL', () => {
  const map = parseSshHostMap('# comment\norderlyClaw2 = custom-claw2\nssh:target-9=box9')
  assert.equal(map.get('orderlyClaw2'), 'custom-claw2')
  assert.equal(map.get('ssh:target-9'), 'box9')

  const jsonMap = parseSshHostMap('{"orderlyClaw2":"json-claw2"}')
  assert.equal(jsonMap.get('orderlyClaw2'), 'json-claw2')

  const registry = {
    environments: [{ id: 'env-uuid-1', name: 'orderlyClaw2', sshTargetId: 'ssh-id-2' }],
    sshHosts: [{ id: 'ssh-id-2', name: 'orderlyClaw2', connected: true }],
  }

  const remoteDefault = resolveWorkspaceHost(
    'runtime:env-uuid-1',
    '/home/node/orderly-voucher-calc',
    registry,
    new Map(),
  )
  assert.equal(remoteDefault.transport, 'remote-orca')
  assert.equal(remoteDefault.supported, true)
  assert.equal(remoteDefault.sshHost, 'orderlyClaw2')
  assert.equal(remoteDefault.environmentName, 'orderlyClaw2')
  assert.equal(remoteDefault.expectedOrcaHostId, 'local')

  const remoteOverridden = resolveWorkspaceHost(
    'runtime:env-uuid-1',
    '/home/node/orderly-voucher-calc',
    registry,
    map,
  )
  assert.equal(remoteOverridden.sshHost, 'custom-claw2')

  const directSsh = resolveWorkspaceHost(
    'ssh:ssh-id-2',
    '/home/node/repo',
    registry,
    new Map(),
  )
  assert.equal(directSsh.transport, 'remote-ssh')
  assert.equal(directSsh.sshHost, 'orderlyClaw2')
  assert.equal(directSsh.environmentName, null)
  assert.equal(directSsh.expectedOrcaHostId, 'ssh:ssh-id-2')

  const wsl = resolveWorkspaceHost(
    'local',
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
    registry,
    new Map(),
  )
  assert.equal(wsl.supported, false)
  assert.equal(wsl.transport, 'unsupported')
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
      sshHostMap: '',
      remoteNode: '',
    },
  })

  const worker = await mountWorker(workerModule, { host })
  try {
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
    assert.equal(status.currentReview.isRemote, false)

    const parsed = new URL(status.currentReview.url)
    const token = new URLSearchParams(parsed.hash.slice(1)).get('token')
    assert.ok(token)

    const noSlash = await fetch(`${parsed.origin}/wt/${status.currentReview.slug}`, {
      redirect: 'manual',
    })
    assert.equal(noSlash.status, 302)
    assert.equal(noSlash.headers.get('location'), `/wt/${status.currentReview.slug}/`)

    const htmlRes = await fetch(`${parsed.origin}${parsed.pathname}`)
    assert.equal(htmlRes.status, 200)
    assert.match(await htmlRes.text(), /<!doctype html>/i)

    const unauth = await fetch(`${parsed.origin}${parsed.pathname}api/diff`)
    assert.equal(unauth.status, 401)

    const headers = { 'X-Skepsis-Token': token }
    const diffRes = await fetch(`${parsed.origin}${parsed.pathname}api/diff`, { headers })
    assert.equal(diffRes.status, 200)
    const diffJson = (await diffRes.json()) as {
      patch: string
      orca?: boolean
      repositoryBrowser?: boolean
      tabSize: number
    }
    assert.match(diffJson.patch, /-  return x \+ 1/)
    assert.match(diffJson.patch, /\+  return x \+ 2/)
    assert.equal(diffJson.orca, true)
    assert.equal(diffJson.repositoryBrowser, true)
    assert.equal(diffJson.tabSize, 4)

    const filesRes = await fetch(`${parsed.origin}${parsed.pathname}api/repository-files`, {
      headers,
    })
    assert.equal(filesRes.status, 200)
    const filesJson = (await filesRes.json()) as { paths: string[]; orca: boolean }
    assert.ok(filesJson.paths.includes('hello.ts'))
    assert.equal(filesJson.orca, true)

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

    await worker.emit('workspace.removed', {
      workspaceId: 'wt-1',
      kind: 'worktree',
      path: repo,
    })
    const afterRemove = await fetch(`${parsed.origin}${parsed.pathname}api/diff`, {
      headers,
    })
    assert.equal(afterRemove.status, 404)

    assert.ok(worker.host.callsOf('statusBar.update').length >= 2)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('worker mounts remote Orca server workspace via stdio runner, serves local UI, remote diff/symbols, and remote Orca delivery', async () => {
  const { tmp, repo, fakeOrca } = await createTempGitRepo('main')
  const runnerPath = join(tmp, 'runner.mjs')
  await writeFile(runnerPath, REMOTE_RUNNER_SOURCE)
  const libPath = join(import.meta.dirname, '..', 'dist', 'lib.js')

  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'wt-remote-1',
        branch: 'main',
        displayName: 'Remote Voucher',
        terminals: [],
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'wt-remote-1',
            kind: 'worktree',
            name: 'Remote Voucher',
            path: repo,
            branch: 'main',
            hostId: 'runtime:env-1',
          },
        ],
        truncated: false,
      },
    },
    settings: {
      openCommand: 'true',
      tabSize: 2,
      diffBase: '',
      orcaBinary: fakeOrca,
      sshHostMap: '',
      remoteNode: '',
    },
  })

  const spawnedHosts: string[] = []
  const customWorker = {
    default: (orca: Parameters<typeof activateWithDeps>[0]) =>
      activateWithDeps(orca, {
        loadRemoteRegistry: async () => ({
          environments: [{ id: 'env-1', name: 'orderlyClaw2', sshTargetId: 'ssh-2' }],
          sshHosts: [{ id: 'ssh-2', name: 'orderlyClaw2', connected: true }],
        }),
        remoteTransportFactory: async ({ sshHost }) => {
          spawnedHosts.push(sshHost)
          return spawn(process.execPath, [runnerPath, libPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
        },
        openBrowser: async () => {},
      }),
    deactivate: workerModule.deactivate,
  }

  const worker = await mountWorker(customWorker, { host })
  try {
    const opened = (await worker.request('skepsis.open', {
      launchBrowser: false,
    })) as { state: PluginState; url: string; opened: boolean }
    assert.deepEqual(spawnedHosts, ['orderlyClaw2'])
    assert.equal(opened.state.currentReview?.isRemote, true)
    assert.equal(opened.state.currentReview?.hostLabel, 'Remote · orderlyClaw2')

    const parsed = new URL(opened.url)
    const token = new URLSearchParams(parsed.hash.slice(1)).get('token')
    assert.ok(token)
    const headers = { 'X-Skepsis-Token': token }

    // 1. Local static HTML served directly from orca-plugin/dist/web
    const htmlRes = await fetch(`${parsed.origin}${parsed.pathname}`)
    assert.equal(htmlRes.status, 200)
    assert.match(await htmlRes.text(), /<!doctype html>/i)

    // 2. Remote diff proxied over stdio with local Orca flags injected
    const diffRes = await fetch(`${parsed.origin}${parsed.pathname}api/diff`, { headers })
    assert.equal(diffRes.status, 200)
    const diffJson = (await diffRes.json()) as {
      patch: string
      orca?: boolean
      send?: boolean
      repositoryBrowser?: boolean
    }
    assert.match(diffJson.patch, /\+  return x \+ 2/)
    assert.equal(diffJson.orca, true)
    assert.equal(diffJson.send, true)
    assert.equal(diffJson.repositoryBrowser, true)

    // 3. Remote symbol jump runs on the remote runner
    const symRes = await fetch(
      `${parsed.origin}${parsed.pathname}api/symbol-definitions?symbol=computeTotal&fromFile=hello.ts`,
      { headers },
    )
    assert.equal(symRes.status, 200)
    const symJson = (await symRes.json()) as {
      definitions: { path: string; line: number }[]
    }
    assert.equal(symJson.definitions[0]?.path, 'hello.ts')
    assert.equal(symJson.definitions[0]?.line, 1)

    // 4. Remote Orca agent listing goes through local CLI with --environment orderlyClaw2
    const targetsRes = await fetch(`${parsed.origin}${parsed.pathname}api/orca/targets`, {
      headers,
    })
    assert.equal(targetsRes.status, 200)
    const targetsJson = (await targetsRes.json()) as {
      workspace: string
      fresh: { id: string }[]
    }
    assert.equal(targetsJson.workspace, 'Remote orderlyClaw2')
    assert.equal(targetsJson.fresh.length, 2)

    // 5. Files-tab review fetches remote file snapshot and delivers to remote Orca agent
    const fileRes = await fetch(
      `${parsed.origin}${parsed.pathname}api/repository-file?path=hello.ts`,
      { headers },
    )
    const fileSnap = (await fileRes.json()) as { path: string; revision: string }
    const reviewRes = await fetch(
      `${parsed.origin}${parsed.pathname}api/repository-review`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          path: fileSnap.path,
          revision: fileSnap.revision,
          lines: [1, 2],
          text: 'Please verify remote increment',
          target: { kind: 'new', id: 'codex' },
        }),
      },
    )
    assert.equal(reviewRes.status, 200)
    assert.deepEqual(await reviewRes.json(), { status: 'Started in Orca' })

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
      sshHostMap: '',
      remoteNode: '',
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

test('worker rejects WSL UNC workspaces cleanly without starting server', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'wt-wsl',
        branch: 'main',
        displayName: 'Ubuntu Box',
        terminals: [],
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'wt-wsl',
            kind: 'worktree',
            name: 'Ubuntu Box',
            path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
            branch: 'main',
            hostId: 'local',
          },
        ],
        truncated: false,
      },
    },
  })

  const worker = await mountWorker(workerModule, { host })
  try {
    const status = (await worker.request('skepsis.status')) as PluginState
    assert.equal(status.focused?.supported, false)
    await assert.rejects(() => worker.command('open-review'), /WSL UNC workspaces/)
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
      name: 'feature/voucher',
      branch: 'feature/voucher',
      path: '/home/node/orderly-voucher-calc',
      kind: 'worktree',
      hostId: 'runtime:env-1',
      transport: 'remote-orca',
      hostLabel: 'Remote · orderlyClaw2',
      sshHost: 'orderlyClaw2',
      environmentName: 'orderlyClaw2',
      supported: true,
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
      name: 'feature/voucher',
      branch: 'feature/voucher',
      path: '/home/node/orderly-voucher-calc',
      hostId: 'runtime:env-1',
      hostLabel: 'Remote · orderlyClaw2',
      isRemote: true,
      url: 'http://127.0.0.1:51234/wt/1234567890ab/#token=abc',
      diffBase: 'Auto merge-base',
      startedAt: Date.now(),
    },
    mounted: [
      {
        slug: '1234567890ab',
        workspaceId: 'wt-1',
        name: 'feature/voucher',
        branch: 'feature/voucher',
        path: '/home/node/orderly-voucher-calc',
        hostId: 'runtime:env-1',
        hostLabel: 'Remote · orderlyClaw2',
        isRemote: true,
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
    assert.ok(view.find({ text: /feature\/voucher/ }))
    assert.ok(view.find({ text: /Remote workspace via SSH/ }))
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
