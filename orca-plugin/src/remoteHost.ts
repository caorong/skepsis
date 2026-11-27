/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WorkspaceTransportKind } from './protocol.ts'

const exec = promisify(execFile)
const REGISTRY_TTL_MS = 15_000

export type OrcaEnvironmentInfo = {
  id: string
  name: string
  sshTargetId: string | null
}

export type OrcaSshHostInfo = {
  id: string
  name: string
  connected: boolean
}

export type OrcaRemoteRegistry = {
  environments: OrcaEnvironmentInfo[]
  sshHosts: OrcaSshHostInfo[]
}

export type ResolvedWorkspaceHost = {
  transport: WorkspaceTransportKind
  supported: boolean
  hostLabel: string
  sshHost: string | null
  environmentName: string | null
  expectedOrcaHostId: string
  reason: string | null
}

/**
 * Parses `sshHostMap` setting (`name=ssh-alias` lines, or a JSON object).
 */
export function parseSshHostMap(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  const trimmed = raw.trim()
  if (!trimmed) return map

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val === 'string' && key.trim() && val.trim()) {
            map.set(key.trim(), val.trim())
          }
        }
        return map
      }
    } catch {
      // Fall through to line-based parsing.
    }
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim()
    if (!clean || clean.startsWith('#')) continue
    const sep = clean.indexOf('=')
    if (sep <= 0) continue
    const key = clean.slice(0, sep).trim()
    const val = clean.slice(sep + 1).trim()
    if (key && val) map.set(key, val)
  }
  return map
}

export function isWslUncPath(path: string | null | undefined): boolean {
  if (!path) return false
  const lower = path.toLowerCase()
  return (
    lower.startsWith('\\\\wsl.localhost\\') ||
    lower.startsWith('\\\\wsl$\\') ||
    lower.startsWith('//wsl.localhost/')
  )
}

function macosBundledOrca(): string | null {
  if (process.platform !== 'darwin') return null
  const candidates = [
    '/Applications/Orca.app/Contents/Resources/bin/orca',
    join(homedir(), 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function runLocalOrcaJson(args: string[], explicitBinary?: string): Promise<unknown> {
  const env = { ...process.env }
  delete env.ORCA_ENVIRONMENT
  const bin = explicitBinary?.trim() || 'orca'

  const invoke = async (cmd: string) => {
    const { stdout } = await exec(cmd, [...args, '--json'], {
      cwd: homedir(),
      env,
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    })
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown }
    return parsed.ok ? parsed.result : null
  }

  try {
    return await invoke(bin)
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    if (failure.code === 'ENOENT' && !explicitBinary?.trim()) {
      const bundled = macosBundledOrca()
      if (bundled) return invoke(bundled)
    }
    throw error
  }
}

export function createRemoteRegistryReader(
  customLoader?: (orcaBinary?: string) => Promise<OrcaRemoteRegistry>,
) {
  let cached: { at: number; binary: string; data: OrcaRemoteRegistry } | null = null

  const loadFresh = async (orcaBinary?: string): Promise<OrcaRemoteRegistry> => {
    if (customLoader) return customLoader(orcaBinary)
    const [envRes, hostRes] = await Promise.all([
      runLocalOrcaJson(['environment', 'list'], orcaBinary).catch(() => null),
      runLocalOrcaJson(['host', 'list'], orcaBinary).catch(() => null),
    ])

    const environments: OrcaEnvironmentInfo[] = []
    const rawEnvs = (envRes as { environments?: unknown[] } | null)?.environments
    if (Array.isArray(rawEnvs)) {
      for (const item of rawEnvs) {
        if (!item || typeof item !== 'object') continue
        const row = item as {
          id?: unknown
          name?: unknown
          orcadDeployment?: { sshTargetId?: unknown }
        }
        if (typeof row.id === 'string' && typeof row.name === 'string') {
          environments.push({
            id: row.id,
            name: row.name,
            sshTargetId:
              typeof row.orcadDeployment?.sshTargetId === 'string'
                ? row.orcadDeployment.sshTargetId
                : null,
          })
        }
      }
    }

    const sshHosts: OrcaSshHostInfo[] = []
    const rawHosts = (hostRes as { hosts?: unknown[] } | null)?.hosts
    if (Array.isArray(rawHosts)) {
      for (const item of rawHosts) {
        if (!item || typeof item !== 'object') continue
        const row = item as {
          kind?: unknown
          id?: unknown
          name?: unknown
          connected?: unknown
        }
        if (
          row.kind === 'ssh' &&
          typeof row.id === 'string' &&
          typeof row.name === 'string'
        ) {
          sshHosts.push({
            id: row.id,
            name: row.name,
            connected: row.connected === true,
          })
        }
      }
    }

    return { environments, sshHosts }
  }

  return async (orcaBinary?: string, force = false): Promise<OrcaRemoteRegistry> => {
    const key = orcaBinary?.trim() ?? ''
    if (
      !force &&
      cached &&
      cached.binary === key &&
      Date.now() - cached.at < REGISTRY_TTL_MS
    ) {
      return cached.data
    }
    const data = await loadFresh(orcaBinary)
    cached = { at: Date.now(), binary: key, data }
    return data
  }
}

export function resolveWorkspaceHost(
  hostId: string | null | undefined,
  path: string | null | undefined,
  registry: OrcaRemoteRegistry,
  sshHostMap: Map<string, string>,
): ResolvedWorkspaceHost {
  if (!path) {
    return {
      transport: 'unsupported',
      supported: false,
      hostLabel: 'Unknown',
      sshHost: null,
      environmentName: null,
      expectedOrcaHostId: 'local',
      reason: 'Workspace has no directory path.',
    }
  }

  if (isWslUncPath(path)) {
    return {
      transport: 'unsupported',
      supported: false,
      hostLabel: 'WSL',
      sshHost: null,
      environmentName: null,
      expectedOrcaHostId: 'local',
      reason: 'WSL UNC workspaces are not yet supported.',
    }
  }

  if (hostId == null || hostId === 'local') {
    return {
      transport: 'local',
      supported: true,
      hostLabel: 'Local',
      sshHost: null,
      environmentName: null,
      expectedOrcaHostId: 'local',
      reason: null,
    }
  }

  if (hostId.startsWith('runtime:')) {
    const envRef = hostId.slice('runtime:'.length)
    const env = registry.environments.find((e) => e.id === envRef || e.name === envRef)
    const envName = env?.name ?? envRef
    const linkedSsh = env?.sshTargetId
      ? registry.sshHosts.find((h) => h.id === env.sshTargetId)
      : undefined
    const sshHost =
      sshHostMap.get(envName) ??
      sshHostMap.get(envRef) ??
      (env?.sshTargetId ? sshHostMap.get(env.sshTargetId) : undefined) ??
      linkedSsh?.name ??
      env?.name ??
      null

    if (!sshHost) {
      return {
        transport: 'unsupported',
        supported: false,
        hostLabel: `Remote (${envName})`,
        sshHost: null,
        environmentName: envName,
        expectedOrcaHostId: 'local',
        reason: `Could not map remote Orca server "${envName}" to an SSH host. Add "${envName}=<ssh-alias>" under Remote SSH Host Overrides in plugin settings.`,
      }
    }

    return {
      transport: 'remote-orca',
      supported: true,
      hostLabel: `Remote · ${envName}`,
      sshHost,
      environmentName: envName,
      // On the remote Orca server itself, its own worktrees report hostId "local".
      expectedOrcaHostId: 'local',
      reason: null,
    }
  }

  if (hostId.startsWith('ssh:')) {
    const targetRef = hostId.slice('ssh:'.length)
    const host = registry.sshHosts.find((h) => h.id === targetRef || h.name === targetRef)
    const sshHost =
      sshHostMap.get(hostId) ??
      sshHostMap.get(targetRef) ??
      (host ? sshHostMap.get(host.name) : undefined) ??
      host?.name ??
      targetRef

    return {
      transport: 'remote-ssh',
      supported: true,
      hostLabel: `SSH · ${sshHost}`,
      sshHost,
      environmentName: null,
      expectedOrcaHostId: hostId,
      reason: null,
    }
  }

  return {
    transport: 'unsupported',
    supported: false,
    hostLabel: hostId,
    sshHost: null,
    environmentName: null,
    expectedOrcaHostId: hostId,
    reason: `Unsupported workspace host "${hostId}".`,
  }
}
