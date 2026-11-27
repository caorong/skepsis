/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import type { FocusedWorkspace, OpenReviewInput, PluginState } from './protocol.ts'
import {
  isLocalWorkspace,
  launchBrowser,
  SkepsisServerManager,
  type CreateAppFn,
  type ServerConfig,
} from './server.ts'

const STATUS_BAR_ID = 'skepsis-status'

type WorkspaceRow = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

export type WorkerDeps = {
  createApp?: CreateAppFn
  openBrowser?: (url: string, openCommand?: string) => Promise<void>
}

let activeTeardown: (() => Promise<void>) | null = null

function parseTabSize(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16) {
    return value
  }
  return 2
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function activateWithDeps(
  orca: OrcaWorkerApi,
  deps: WorkerDeps = {},
): Promise<void> {
  if (activeTeardown) {
    await activeTeardown()
  }

  const manager = new SkepsisServerManager(deps.createApp)
  const openBrowser = deps.openBrowser ?? launchBrowser
  const disposables: Disposable[] = []
  let lastError: string | null = null

  async function readConfig(): Promise<ServerConfig & { openCommand: string }> {
    try {
      const raw = await orca.settings.get()
      return {
        openCommand: asString(raw.openCommand),
        tabSize: parseTabSize(raw.tabSize),
        diffBase: asString(raw.diffBase),
        orcaBinary: asString(raw.orcaBinary),
      }
    } catch {
      return { openCommand: '', tabSize: 2, diffBase: '', orcaBinary: '' }
    }
  }

  async function listWorkspaces(): Promise<WorkspaceRow[]> {
    const res = await orca.host.call('workspace.list')
    return res.workspaces
  }

  async function resolveWorkspace(workspaceId?: string): Promise<FocusedWorkspace | null> {
    const context = workspaceId ? null : await orca.host.call('workspace.readContext')
    const targetId = workspaceId ?? context?.workspaceId
    const rows = await listWorkspaces()

    let match: WorkspaceRow | undefined
    if (targetId) {
      match = rows.find((row) => row.id === targetId)
    } else if (context) {
      match = rows.find(
        (row) => row.name === context.displayName && (row.branch ?? '') === context.branch,
      )
    }

    if (!match) {
      if (!context) return null
      return {
        id: context.workspaceId ?? context.displayName,
        name: context.displayName,
        branch: context.branch || null,
        path: null,
        kind: null,
        isLocal: false,
        reason: 'Could not locate this workspace path in Orca.',
      }
    }

    const localCheck = isLocalWorkspace(match.hostId, match.path)
    return {
      id: match.id,
      name: match.name,
      branch: match.branch,
      path: match.path,
      kind: match.kind,
      isLocal: localCheck.ok,
      reason: localCheck.ok ? null : localCheck.reason,
    }
  }

  async function buildState(workspaceId?: string): Promise<PluginState> {
    const [focused, config] = await Promise.all([
      resolveWorkspace(workspaceId).catch(() => null),
      readConfig(),
    ])
    const mounted = manager.listMounted()
    const currentReview = manager.findByPath(focused?.path)
    return {
      running: manager.running,
      port: manager.port,
      focused,
      currentReview,
      mounted,
      openCommand: config.openCommand,
      lastError,
    }
  }

  async function updateStatusBar(state: PluginState): Promise<void> {
    if (!orca.host.has('statusBar.update')) return
    let text = 'Skepsis'
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' = 'neutral'
    let tooltip = 'Open Skepsis code review in browser'

    if (state.currentReview && state.port !== null) {
      text = `Skepsis · :${state.port}`
      tone = 'success'
      tooltip = `Open Skepsis review for ${state.currentReview.name} (${state.currentReview.url})`
    } else if (state.running && state.mounted.length > 0) {
      text = `Skepsis · ${state.mounted.length}`
      tone = 'accent'
      tooltip = state.focused
        ? `Open Skepsis review for ${state.focused.name}`
        : `Skepsis server running (${state.mounted.length} active)`
    } else if (state.focused && !state.focused.isLocal) {
      tone = 'warning'
      tooltip = state.focused.reason ?? 'Skepsis only supports local workspaces'
    }

    try {
      await orca.host.call('statusBar.update', {
        id: STATUS_BAR_ID,
        text,
        icon: 'code',
        tone,
        tooltip,
      })
    } catch {
      // Status bar updates are desktop-only; ignore when unavailable.
    }
  }

  async function broadcastState(workspaceId?: string): Promise<PluginState> {
    const state = await buildState(workspaceId)
    await updateStatusBar(state)
    orca.panels.post('skepsis.state', state)
    return state
  }

  async function openReview(
    input: OpenReviewInput = {},
    notifyOnError = false,
  ): Promise<{ state: PluginState; url: string; opened: boolean }> {
    try {
      const [focused, config] = await Promise.all([
        resolveWorkspace(input.workspaceId),
        readConfig(),
      ])
      if (!focused) {
        throw new Error('No active workspace. Focus a local workspace in Orca first.')
      }
      if (!focused.isLocal || !focused.path) {
        throw new Error(focused.reason ?? 'Skepsis only supports local workspaces.')
      }

      const mounted = await manager.ensureMounted(
        {
          workspaceId: focused.id,
          name: focused.name,
          branch: focused.branch,
          path: focused.path,
        },
        config,
      )

      let opened = false
      if (input.launchBrowser !== false) {
        await openBrowser(mounted.url, config.openCommand)
        opened = true
      }

      lastError = null
      orca.log(`Serving ${mounted.name} (${mounted.diffBase}) at ${mounted.url}`)
      const state = await broadcastState()
      return { state, url: mounted.url, opened }
    } catch (error) {
      const message = errorMessage(error)
      lastError = message
      orca.log(`Failed to open review: ${message}`)
      await broadcastState().catch(() => {})
      if (notifyOnError) {
        await orca.host
          .call('notifications.show', {
            title: 'Skepsis Review',
            body: message,
          })
          .catch(() => {})
      }
      throw new Error(message, { cause: error })
    }
  }

  disposables.push(
    orca.commands.register('open-review', async () => {
      const { url } = await openReview({ launchBrowser: true }, true)
      return `Opened Skepsis review: ${url}`
    }),
    orca.commands.register('stop-server', async () => {
      await manager.stop()
      lastError = null
      orca.log('Stopped Skepsis review server')
      await broadcastState()
      return 'Stopped Skepsis review server'
    }),
    orca.panels.handle('skepsis.status', async () => {
      const state = await buildState()
      await updateStatusBar(state)
      return state
    }),
    orca.panels.handle('skepsis.open', async (input) => openReview(input ?? {}, false)),
    orca.panels.handle('skepsis.stop', async () => {
      await manager.stop()
      lastError = null
      orca.log('Stopped Skepsis review server')
      return broadcastState()
    }),
    orca.panels.handle('skepsis.unmount', async ({ path }) => {
      manager.unmountPath(path)
      return broadcastState()
    }),
    orca.events.on('workspace.changed', async () => {
      await broadcastState()
    }),
    orca.events.on('workspace.removed', async ({ path }) => {
      if (manager.unmountPath(path)) {
        orca.log(`Unmounted removed workspace: ${path}`)
        await broadcastState()
      }
    }),
    orca.settings.onDidChange(() => {
      void broadcastState()
    }),
  )

  activeTeardown = async () => {
    activeTeardown = null
    for (const item of disposables.splice(0)) {
      item.dispose()
    }
    await manager.stop()
  }

  await broadcastState()
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await activateWithDeps(orca)
}

export async function deactivate(): Promise<void> {
  if (activeTeardown) {
    await activeTeardown()
  }
}
