/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { once } from 'node:events'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { TOKEN_HEADER } from '../shared/types.ts'
import { startCli } from '../server/testUtil.ts'
import { browserTest, expect, makeRepo, test } from './fixtures.ts'

async function openFiles(page: Page) {
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByText('Repository files')).toBeVisible()
}

async function openReview(page: Page, line: number) {
  const number = page.locator(`.repo-codeview [data-column-number="${line}"]`).first()
  await expect(async () => {
    await number.hover()
    await number.locator('[data-gutter-utility-slot]').click({ timeout: 500 })
  }).toPass()
}

browserTest('Files works when the diff is empty', async ({ page }) => {
  const { dir, home, env } = await makeRepo({
    committed: { 'src/unchanged.ts': 'export const one = 1\n' },
    working: {},
  })
  const { proc, url } = await startCli(dir, ['--git'], env)
  try {
    await page.goto(url)
    await expect(page.locator('.empty-diff')).toContainText('is empty')
    await openFiles(page)
    await page.getByRole('treeitem', { name: 'src' }).click()
    await page.getByRole('treeitem', { name: 'unchanged.ts' }).click()
    await expect(page.locator('.repo-codeview')).toContainText('export const one = 1')
  } finally {
    const exited = once(proc, 'exit')
    proc.kill()
    await exited
    await Promise.all([dir, home].map((path) => rm(path, { recursive: true, force: true })))
  }
})

test('Files reviews an unchanged file without writing to it', async ({ page, repo }) => {
  await openFiles(page)
  await page.getByRole('treeitem', { name: 'long.ts' }).click()
  await expect(page.locator('.repo-codeview')).toContainText('// line 1')
  await openReview(page, 3)
  await page.getByPlaceholder('Leave a review comment').fill('Unchanged line note')
  await page.getByRole('button', { name: 'Save note' }).click()
  await expect(page.getByText('Unchanged line note')).toBeVisible()
  expect(await repo.read('long.ts')).not.toContain('Unchanged line note')
  await page.getByRole('button', { name: 'Diff', exact: true }).click()
  await openFiles(page)
  await expect(page.getByText('Unchanged line note')).toBeVisible()
})

test('a changed file opens in Files with full context', async ({ page }) => {
  await page
    .locator('.file-header')
    .first()
    .getByRole('button', { name: 'Open full file' })
    .click()
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.repo-codeview')).toContainText('const one = 1')
  await expect(page.locator('.repo-codeview')).toContainText('const four = 4')
})

test.describe('review delivery', () => {
  test.use({ cliArgs: ['--send', 'cat >> .git/files-sent.jsonl'] })

  test('sends working-tree line context and rejects stale or excluded paths', async ({
    page,
    repo,
  }) => {
    await openFiles(page)
    await page.getByRole('treeitem', { name: 'long.ts' }).click()
    await openReview(page, 3)
    await page
      .getByPlaceholder('Leave a review comment')
      .fill('Explain this unchanged line')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Sent · External command')).toBeVisible()
    const payload = JSON.parse(
      (await readFile(join(repo.dir, '.git/files-sent.jsonl'), 'utf8')).trim(),
    )
    expect(payload).toMatchObject({ scope: 'working-tree', file: 'long.ts', lines: [3, 3] })
    expect(payload.prompt).toContain('Review comment on long.ts, line 3 (working tree)')
    expect(payload.prompt).toContain('// line 3')

    const base = new URL(repo.url)
    const token = new URLSearchParams(base.hash.slice(1)).get('token')!
    const headers = { [TOKEN_HEADER]: token, Origin: base.origin }
    const url = (suffix: string) => new URL(suffix, base).href
    const initial = await page.request.get(url('/api/repository-file?path=long.ts'), {
      headers,
    })
    const { revision } = await initial.json()
    await repo.write('long.ts', 'now changed\n')
    const stale = await page.request.post(url('/api/repository-review'), {
      headers,
      data: { path: 'long.ts', lines: [3, 3], revision, text: 'stale draft' },
    })
    expect(stale.status()).toBe(409)
    await writeFile(join(repo.dir, '.git/info/exclude'), 'excluded.txt\n')
    await repo.write('excluded.txt', 'not reviewable')
    await symlink(join(repo.dir, '.git/config'), join(repo.dir, 'link.txt'))
    const excluded = ['.git/config', '../not-this-repo.txt', 'excluded.txt', 'link.txt']
    const denied = await Promise.all(
      excluded.map((path) =>
        page.request.get(url('/api/repository-file?' + new URLSearchParams({ path })), {
          headers,
        }),
      ),
    )
    expect(denied.every((result) => !result.ok())).toBe(true)
    const unauth = await page.request.get(url('/api/repository-files'))
    expect(unauth.status()).toBe(401)
    const catalog = await page.request.get(url('/api/repository-files'), { headers })
    expect((await catalog.json()).paths).not.toContain('excluded.txt')
    expect(
      (await readFile(join(repo.dir, '.git/files-sent.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1)
  })
})
