/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { Page } from '@playwright/test'
import { startCli } from '../server/testUtil.ts'
import { TOKEN_HEADER } from '../shared/types.ts'
import { browserTest, COMMITTED, expect, makeRepo, WORKING } from './fixtures.ts'

const scope = 'repo-id::review-root'
const fake = String.raw`
(async () => {
const fs = require('node:fs');
const { setTimeout } = require('node:timers/promises');
const args = process.argv.slice(2);
const [area, action] = args;
const flag = (name) => args[args.indexOf(name) + 1];
const scope = '${scope}';
const row = { kind: 'chat', agent: 'codex', state: 'working', worktreeId: scope, hostId: 'local', paneKey: 'tab:a', title: 'Existing Codex' };
const reply = (result) => console.log(JSON.stringify({ id: 'request', ok: true, result, _meta: { runtimeId: 'fixture' } }));
const stop = (code) => { console.log(JSON.stringify({ ok: false, error: { code } })); process.exit(1); };
const log = () => fs.appendFileSync('.git/orca.jsonl', JSON.stringify(args) + '\n');
if (area === 'worktree' && action === 'current') {
  return reply({ worktree: { id: scope, path: process.cwd(), displayName: 'Review workspace', hostId: 'local' } });
}
if (area === 'agent' && action === 'list') {
  return reply({ agents: [
    { ...row, orcaSessionId: 'codex-session' },
    { ...row, kind: 'terminal', agent: 'antigravity', title: 'Existing Agy', orcaSessionId: 'agy-session', paneKey: 'tab:leaf' },
    { ...row, kind: 'terminal', title: 'Sleeping agent', orcaSessionId: 'sleep-session', paneKey: 'sleep:leaf' },
    { ...row, title: 'Other worktree', orcaSessionId: 'other-session', worktreeId: 'other' },
    { ...row, title: 'Other host', orcaSessionId: 'remote-session', hostId: 'ssh:remote' }
  ]});
}
if (area === 'agent' && action === 'installed') {
  return reply({ agents: [{ id: 'claude', name: 'Claude Code' }] });
}
if (area === 'terminal' && action === 'list') {
  const term = { handle: 'term_agy', worktreeId: scope, tabId: 'tab', leafId: 'leaf', connected: true, writable: true, agentIdentity: 'antigravity' };
  return reply({ terminals: fs.existsSync('.git/sender')
    ? [term, { ...term, handle: 'term_sender', tabId: 'sender', agentIdentity: undefined }]
    : [term] });
}
if (area === 'terminal' && action === 'create') {
  log();
  fs.writeFileSync('.git/sender', '');
  return reply({ terminal: { handle: 'term_sender', worktreeId: scope } });
}
if (area === 'orchestration' && action === 'send') {
  log();
  if (flag('--from') !== 'term_sender') return stop('bad_sender');
  while (!fs.existsSync('.git/release')) await setTimeout(20);
  if (flag('--to') === 'term_agy') return stop('fixture_refusal');
  return reply({ message: { id: 'message' } });
}
if (area === 'agent' && action === 'launch') {
  log();
  return reply({ worktreeId: scope, outcome: { kind: 'structured' }, prompt: { outcome: 'journaled' } });
}
return stop('unexpected_command');
})();
`

const test = browserTest.extend<{
  review: { dir: string; url: string }
}>({
  review: async ({ page }, provide) => {
    const { dir, home, env } = await makeRepo({ committed: COMMITTED, working: WORKING })
    const bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'orca.cjs'), fake)
    await writeFile(
      join(bin, 'orca'),
      '#!/bin/sh\nexec node "$(dirname "$0")/orca.cjs" "$@"\n',
      { mode: 0o755 },
    )
    const { proc, url } = await startCli(dir, ['--git', '--orca'], {
      ...env,
      PATH: bin + delimiter + (process.env.PATH ?? ''),
    })
    try {
      await page.goto(url)
      await page.locator('.file-header').first().waitFor()
      await provide({ dir, url })
    } finally {
      const exited = once(proc, 'exit')
      proc.kill()
      await exited
      await Promise.all(
        [dir, home].map((path) => rm(path, { force: true, recursive: true })),
      )
    }
  },
})

const composer = (page: Page) => page.getByPlaceholder('Leave a review comment')

async function clickLine(page: Page, fileIndex: number) {
  const line = page
    .locator('diffs-container')
    .nth(fileIndex)
    .locator('[data-additions] [data-column-number="2"]')
    .first()
  await expect(async () => {
    await line.hover()
    await line.locator('[data-gutter-utility-slot]').click({ timeout: 1_000 })
  }).toPass()
  await expect(composer(page)).toBeFocused()
}

async function commands(dir: string): Promise<string[][]> {
  const raw = await readFile(join(dir, '.git', 'orca.jsonl'), 'utf8').catch(() => '')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('routes line comments to existing and new Orca agents without blocking another review', async ({
  page,
  review,
}) => {
  await clickLine(page, 0)
  await expect(page.getByText('Orca · Review workspace')).toBeVisible()
  await expect(page.getByText('Other worktree')).toHaveCount(0)
  await expect(page.getByText('Other host')).toHaveCount(0)
  await expect(page.getByText('Sleeping agent')).toHaveCount(0)
  await composer(page).fill('Why change this? 继续检查 $HOME')
  await expect(page.getByRole('button', { name: 'Send to Orca' })).toBeDisabled()
  await page.getByRole('checkbox', { name: /Existing Codex/ }).check()
  await page.getByRole('checkbox', { name: /Existing Agy/ }).check()
  await page.getByRole('button', { name: 'Send to 2 Agents' }).click()
  await expect(composer(page)).toBeHidden()
  await expect(page.getByText(/Sending to Orca/)).toHaveCount(2)

  await clickLine(page, 1)
  await page.getByRole('checkbox', { name: 'Claude Code' }).check()
  await composer(page).fill('Explain this new line')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByText(/Started in Orca · Claude Code/)).toBeVisible()
  await expect(page.getByText(/Sending to Orca/)).toHaveCount(2)

  await writeFile(join(review.dir, '.git', 'release'), '')
  await expect(page.getByText(/Accepted by Orca · Existing Codex/)).toBeVisible()
  await expect(page.getByText(/Delivery not confirmed · Existing Agy/)).toBeVisible()
  await expect(page.getByText(/fixture_refusal/)).toBeVisible()
  const log = await commands(review.dir)
  expect(log.filter((cmd) => cmd[1] === 'create')).toHaveLength(1)
  const sends = log.filter((cmd) => cmd[1] === 'send')
  expect(sends).toHaveLength(2)
  expect(sends.map((cmd) => cmd[cmd.indexOf('--to') + 1]).toSorted()).toEqual([
    'orca_session_id:codex-session',
    'term_agy',
  ])
  for (const cmd of sends) {
    const body = cmd[cmd.indexOf('--body') + 1]
    expect(body).toContain('Review comment on a.ts, line 2')
    expect(body).toContain('Why change this? 继续检查 $HOME')
    expect(body).toContain('Reviewed blob:')
  }
  expect(log.find((cmd) => cmd[1] === 'launch')?.join(' ')).toContain('b.txt, line 2')
  expect(await readFile(join(review.dir, 'a.ts'), 'utf8')).toBe(WORKING['a.ts'])
  expect(await readFile(join(review.dir, 'b.txt'), 'utf8')).toBe(WORKING['b.txt'])
})

test('rejects another origin and an out-of-worktree agent without running a mutation', async ({
  page,
  review,
}) => {
  const base = new URL(review.url)
  const token = new URLSearchParams(base.hash.slice(1)).get('token')!
  const endpoint = new URL('/api/orca/send', base).href
  const data = {
    target: { kind: 'existing', id: 'other-session' },
    file: 'a.ts',
    lines: [2, 2],
    side: 'additions',
    blob: null,
    columns: null,
    code: null,
    text: 'Review this',
  }
  expect((await page.request.post(endpoint, { data })).status()).toBe(401)
  expect(
    (
      await page.request.post(endpoint, {
        data,
        headers: { [TOKEN_HEADER]: token, Origin: 'https://example.com' },
      })
    ).status(),
  ).toBe(403)
  const reply = await page.request.post(endpoint, {
    data,
    headers: { [TOKEN_HEADER]: token, Origin: base.origin },
  })
  expect(reply.status()).toBe(502)
  expect(await reply.json()).toMatchObject({
    error: expect.stringContaining('not open in this workspace'),
  })
  expect(await commands(review.dir)).toEqual([])
})
