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
    name: 'feature/review',
    branch: 'feature/review',
    path: '/Users/dev/project',
    kind: 'worktree',
    isLocal: true,
    reason: null,
  },
  currentReview: {
    slug: 'a1b2c3d4e5f6',
    workspaceId: 'wt-1',
    name: 'feature/review',
    branch: 'feature/review',
    path: '/Users/dev/project',
    url: 'http://127.0.0.1:49152/wt/a1b2c3d4e5f6/#token=exampletoken',
    diffBase: 'Auto merge-base',
    startedAt: 1700000000000,
  },
  mounted: [
    {
      slug: 'a1b2c3d4e5f6',
      workspaceId: 'wt-1',
      name: 'feature/review',
      branch: 'feature/review',
      path: '/Users/dev/project',
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
      url: 'http://127.0.0.1:49152/wt/fedcba987654/#token=othertoken',
      diffBase: 'HEAD (fallback)',
      startedAt: 1699999000000,
    },
  ],
  openCommand: 'open -a "Google Chrome"',
  lastError: null,
}

const remoteState: PluginState = {
  running: false,
  port: null,
  focused: {
    id: 'wt-remote',
    name: 'prod-box',
    branch: 'main',
    path: '/home/dev/repo',
    kind: 'worktree',
    isLocal: false,
    reason: 'Workspace is on ssh:prod-box. Skepsis only supports local workspaces.',
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
    name: 'notes',
    branch: null,
    path: '/Users/dev/notes',
    kind: 'folder',
    isLocal: true,
    reason: null,
  },
  currentReview: null,
  mounted: [],
  openCommand: '',
  lastError: 'Not in a jj or git repository',
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
  serving: {
    requests: {
      'skepsis.status': servingState,
    },
  },
  'remote workspace': {
    requests: {
      'skepsis.status': remoteState,
    },
  },
  error: {
    requests: {
      'skepsis.status': errorState,
    },
  },
})
