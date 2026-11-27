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
  // Target line from the diff hunk is highlighted in the full file view.
  await expect(
    page.locator('.repo-codeview [data-editor-active-line]').first(),
  ).toHaveAttribute('data-column-number', '2')
  // View in diff returns to Diff mode focused on that file.
  await page.getByRole('button', { name: 'View in diff', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Diff', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.file-header.focused .file-header-name')).toHaveText('a.ts')
})

test('switching Diff and Files preserves Diff state and keeps unified top bar controls', async ({
  page,
  repo,
}) => {
  // Collapse a.ts and focus b.txt in Diff view.
  await page
    .locator('.file-header', { hasText: 'a.ts' })
    .locator('.collapse-chevron')
    .click()
  await expect(
    page.locator('.file-header', { hasText: 'a.ts' }).locator('.collapse-chevron'),
  ).toHaveClass(/collapsed/)
  await page.keyboard.press('n')
  await expect(page.locator('.file-header.focused .file-header-name')).toHaveText('b.txt')

  // Switch to Files: unified top bar provides theme toggle, help, and sidebar toggle.
  await openFiles(page)
  await expect(page.getByRole('button', { name: 'Diff', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeHidden()

  // Cmd/Ctrl+K focuses tree search; b hides/shows tree.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.locator('.repo-browser-tree .file-tree input')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('b')
  await expect(page.locator('.repo-browser-tree')).toBeHidden()
  await page.keyboard.press('b')
  await expect(page.locator('.repo-browser-tree')).toBeVisible()

  // Inline composer renders inside .repo-codeview, supports Escape, and Cmd/Ctrl+F searches.
  await page.getByRole('treeitem', { name: 'long.ts' }).click()
  await expect(page.locator('.repo-codeview')).toContainText('// line 1')
  await page.keyboard.press('ControlOrMeta+f')
  const findInput = page.locator('.repo-codeview [data-search-panel] input[data-search]')
  await expect(findInput).toBeFocused()
  await findInput.pressSequentially('line 42')
  await expect(
    page.locator('.repo-codeview [data-search-panel] [data-matches]'),
  ).toHaveText('1/1')
  await page.keyboard.press('Escape')
  await expect(findInput).toHaveCount(0)

  await openReview(page, 3)
  await expect(page.locator('.repo-codeview .repo-inline-composer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.repo-codeview .repo-inline-composer')).toHaveCount(0)

  // Save a note, modify the file on disk, and refresh: earlier-revision note is surfaced.
  await openReview(page, 3)
  await page.getByPlaceholder('Leave a review comment').fill('Old revision note')
  await page.getByRole('button', { name: 'Save note' }).click()
  await expect(page.getByText('Old revision note')).toBeVisible()
  await repo.write('long.ts', '// edited line 1\n' + (await repo.read('long.ts')))
  await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
  await expect(page.getByText('1 note from an earlier revision of this file')).toBeVisible()
  await page.getByRole('button', { name: 'Show', exact: true }).click()
  await expect(page.getByText('Old revision note')).toBeVisible()

  // Switch back to Diff: a.ts stays collapsed and b.txt stays focused.
  await page.getByRole('button', { name: 'Diff', exact: true }).click()
  await expect(
    page.locator('.file-header', { hasText: 'a.ts' }).locator('.collapse-chevron'),
  ).toHaveClass(/collapsed/)
  await expect(page.locator('.file-header.focused .file-header-name')).toHaveText('b.txt')
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
