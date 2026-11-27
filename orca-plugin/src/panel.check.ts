/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { defineCheck } from 'orca/testing'
import type { PluginState } from './protocol.ts'

const servingState: PluginState = {
  running: true,
  port: 49152,
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
  currentReview: {
    slug: 'a1b2c3d4e5f6',
    workspaceId: 'wt-1',
    name: 'feature/voucher',
    branch: 'feature/voucher',
    path: '/home/node/orderly-voucher-calc',
    hostId: 'runtime:env-1',
    hostLabel: 'Remote · orderlyClaw2',
    isRemote: true,
    url: 'http://127.0.0.1:49152/wt/a1b2c3d4e5f6/#token=exampletoken',
    diffBase: 'Auto merge-base',
    startedAt: 1700000000000,
  },
  mounted: [
    {
      slug: 'a1b2c3d4e5f6',
      workspaceId: 'wt-1',
      name: 'feature/voucher',
      branch: 'feature/voucher',
      path: '/home/node/orderly-voucher-calc',
      hostId: 'runtime:env-1',
      hostLabel: 'Remote · orderlyClaw2',
      isRemote: true,
      url: 'http://127.0.0.1:49152/wt/a1b2c3d4e5f6/#token=exampletoken',
      diffBase: 'Auto merge-base',
      startedAt: 1700000000000,
    },
    {
      slug: 'fedcba987654',
      workspaceId: 'wt-2',
      name: 'bugfix/auth',
      branch: 'bugfix/auth',
      path: '/Users/dev/project-auth',
      hostId: 'local',
      hostLabel: 'Local',
      isRemote: false,
      url: 'http://127.0.0.1:49152/wt/fedcba987654/#token=othertoken',
      diffBase: 'HEAD (fallback)',
      startedAt: 1699999000000,
    },
  ],
  openCommand: 'open -a "Google Chrome"',
  lastError: null,
}

const remoteIdleState: PluginState = {
  running: false,
  port: null,
  focused: {
    id: 'wt-remote',
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

const unsupportedState: PluginState = {
  running: false,
  port: null,
  focused: {
    id: 'wt-wsl',
    name: 'ubuntu-repo',
    branch: 'main',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    kind: 'worktree',
    hostId: 'local',
    transport: 'unsupported',
    hostLabel: 'WSL',
    sshHost: null,
    environmentName: null,
    supported: false,
    reason: 'WSL UNC workspaces are not yet supported.',
  },
  currentReview: null,
  mounted: [],
  openCommand: '',
  lastError: null,
}

const errorState: PluginState = {
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
  openCommand: '',
  lastError:
    'Remote host "orderlyClaw2" does not have Node.js installed. Install Node.js 22+ on "orderlyClaw2".',
}

export default defineCheck({
  'no workspace': {
    results: {
      'workspace.readContext': null,
      'workspace.list': { workspaces: [], truncated: false },
    },
  },
  'local idle': {
    results: {
      'workspace.readContext': {
        workspaceId: 'wt-1',
        branch: 'feature/review',
        displayName: 'feature/review',
        terminals: [],
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'wt-1',
            kind: 'worktree',
            name: 'feature/review',
            path: '/Users/dev/project',
            branch: 'feature/review',
            hostId: 'local',
          },
        ],
        truncated: false,
      },
    },
  },
  'remote idle': {
    requests: {
      'skepsis.status': remoteIdleState,
    },
  },
  serving: {
    requests: {
      'skepsis.status': servingState,
    },
  },
  'unsupported workspace': {
    requests: {
      'skepsis.status': unsupportedState,
    },
  },
  error: {
    requests: {
      'skepsis.status': errorState,
    },
  },
})
