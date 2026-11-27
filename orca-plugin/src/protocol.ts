/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

export type WorkspaceTransportKind = 'local' | 'remote-orca' | 'remote-ssh' | 'unsupported'

export type FocusedWorkspace = {
  id: string
  name: string
  branch: string | null
  path: string | null
  kind: 'worktree' | 'folder' | null
  hostId: string | null
  transport: WorkspaceTransportKind
  hostLabel: string
  sshHost: string | null
  environmentName: string | null
  supported: boolean
  reason: string | null
}

export type MountedSummary = {
  slug: string
  workspaceId: string | null
  name: string
  branch: string | null
  path: string
  hostId: string | null
  hostLabel: string
  isRemote: boolean
  url: string
  diffBase: string
  startedAt: number
}

export type PluginState = {
  running: boolean
  port: number | null
  focused: FocusedWorkspace | null
  currentReview: MountedSummary | null
  mounted: MountedSummary[]
  openCommand: string
  lastError: string | null
}

export type OpenReviewInput = {
  workspaceId?: string
  launchBrowser?: boolean
}

export type OpenReviewOutput = {
  state: PluginState
  url: string
  opened: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'skepsis.status': { output: PluginState }
    'skepsis.open': { input: OpenReviewInput | undefined; output: OpenReviewOutput }
    'skepsis.stop': { output: PluginState }
    'skepsis.unmount': {
      input: { path: string; hostId?: string | null }
      output: PluginState
    }
  }
  interface PluginPanelEvents {
    'skepsis.state': PluginState
  }
}
