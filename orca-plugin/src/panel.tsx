/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  IconButton,
  KeyValue,
  Link,
  List,
  ListItem,
  on,
  type PanelContext,
  plugin,
  read,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
} from 'orca'
import type { MountedSummary, PluginState } from './protocol.ts'

const stateAtom = atom<PluginState | null>(null)
const loadingAtom = atom(true)
const busyAtom = atom(false)
const actionErrorAtom = atom<string | null>(null)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function refreshStatus(signal?: AbortSignal): Promise<void> {
  try {
    const next = await plugin.request('skepsis.status', undefined, { signal })
    if (signal?.aborted) return
    set(stateAtom, next)
    set(actionErrorAtom, null)
  } catch (error) {
    if (signal?.aborted) return
    set(actionErrorAtom, errorMessage(error))
  } finally {
    if (!signal?.aborted) {
      set(loadingAtom, false)
    }
  }
}

async function openWorkspace(workspaceId?: string): Promise<void> {
  set(busyAtom, true)
  set(actionErrorAtom, null)
  try {
    const res = await plugin.request('skepsis.open', {
      workspaceId,
      launchBrowser: true,
    })
    set(stateAtom, res.state)
  } catch (error) {
    set(actionErrorAtom, errorMessage(error))
  } finally {
    set(busyAtom, false)
  }
}

async function stopServer(): Promise<void> {
  set(busyAtom, true)
  set(actionErrorAtom, null)
  try {
    const next = await plugin.request('skepsis.stop')
    set(stateAtom, next)
  } catch (error) {
    set(actionErrorAtom, errorMessage(error))
  } finally {
    set(busyAtom, false)
  }
}

export function setup(ctx: PanelContext): void {
  set(loadingAtom, true)
  set(actionErrorAtom, null)
  ctx.subscriptions.push(
    plugin.on('skepsis.state', (next) => {
      set(stateAtom, next)
      set(loadingAtom, false)
    }),
    on('workspace.changed', () => {
      void refreshStatus(ctx.signal)
    }),
  )
  void refreshStatus(ctx.signal)
}

function ActiveSessionList({
  items,
  currentPath,
  busy,
}: {
  items: MountedSummary[]
  currentPath: string | null
  busy: boolean
}) {
  if (items.length === 0) return null
  return (
    <Stack gap="xs">
      <Heading level={2}>Active reviews ({items.length})</Heading>
      <List label="Active review sessions">
        {items.map((item) => (
          <ListItem
            key={item.path}
            title={item.name}
            description={item.branch ? `${item.branch} · ${item.diffBase}` : item.diffBase}
            icon="branch"
            current={item.path === currentPath}
            disabled={busy}
            onPress={() => {
              if (item.workspaceId) {
                void openWorkspace(item.workspaceId)
              }
            }}
          />
        ))}
      </List>
    </Stack>
  )
}

export default function SkepsisPanel() {
  const state = read(stateAtom)
  const loading = read(loadingAtom)
  const busy = read(busyAtom)
  const actionError = read(actionErrorAtom)

  const displayError = actionError ?? state?.lastError ?? null
  const focused = state?.focused ?? null
  const currentReview = state?.currentReview ?? null
  const running = state?.running ?? false

  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="sm">
        <Row gap="xs" align="center">
          <Heading level={1}>Skepsis</Heading>
          <Badge tone={running ? 'success' : 'neutral'}>
            {running && state?.port ? `:${state.port}` : 'Idle'}
          </Badge>
        </Row>
        <IconButton
          icon="refresh"
          label="Refresh status"
          variant="ghost"
          size="sm"
          disabled={busy}
          onPress={() => void refreshStatus()}
        />
      </Row>

      {displayError ? (
        <Callout tone="danger" title="Could not open Skepsis" icon="error">
          <Text size="sm">{displayError}</Text>
        </Callout>
      ) : null}

      {loading && !state ? (
        <Box padding="md" align="center">
          <Spinner label="Loading workspace status" />
        </Box>
      ) : !focused ? (
        <EmptyState
          icon="folder"
          title="No active workspace"
          description="Focus a local Git or jj workspace in Orca to open Skepsis code review."
        />
      ) : (
        <Card
          title={focused.name}
          description={focused.branch ? `Branch: ${focused.branch}` : 'Local workspace'}
        >
          <Stack gap="sm">
            {!focused.isLocal ? (
              <Callout tone="warning" title="Local workspaces only" icon="warning">
                <Text size="sm">
                  {focused.reason ?? 'Skepsis only supports local workspaces.'}
                </Text>
              </Callout>
            ) : null}

            <Row gap="sm" wrap>
              <Button
                variant="solid"
                tone="accent"
                icon="open-external"
                disabled={!focused.isLocal || busy}
                onPress={() => void openWorkspace(focused.id)}
              >
                {busy
                  ? 'Opening…'
                  : currentReview
                    ? 'Open in Browser'
                    : 'Start & Open in Browser'}
              </Button>
              {running ? (
                <Button
                  variant="outline"
                  tone="danger"
                  icon="stop"
                  disabled={busy}
                  onPress={() => void stopServer()}
                >
                  Stop Server
                </Button>
              ) : null}
            </Row>

            {currentReview ? (
              <Stack gap="xs">
                <Separator />
                <KeyValue
                  label="Current review session"
                  items={[
                    { label: 'Status', value: 'Serving', tone: 'success' },
                    { label: 'Diff base', value: currentReview.diffBase },
                    {
                      label: 'Opener',
                      value: state?.openCommand || 'System default browser',
                    },
                  ]}
                />
                <Row justify="between" align="center" gap="xs">
                  <Text size="xs" muted>
                    Review URL (includes session token)
                  </Text>
                  <Link href={currentReview.url}>Open link</Link>
                </Row>
                <Code block>{currentReview.url}</Code>
              </Stack>
            ) : null}
          </Stack>
        </Card>
      )}

      {state && state.mounted.length > 0 ? (
        <ActiveSessionList
          items={state.mounted}
          currentPath={focused?.path ?? null}
          busy={busy}
        />
      ) : null}

      <Text size="xs" muted>
        Tip: Click Skepsis in the bottom status bar or press Mod+Alt+R to open this
        workspace in Chrome. Configure a custom browser command in Settings → Plugins →
        Skepsis Review.
      </Text>
    </Stack>
  )
}
