/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { startCli } from '../server/testUtil.ts'
import { browserTest, expect, makeRepo } from './fixtures.ts'

const COMMITTED: Record<string, string> = {
  'src/VoucherController.java': [
    'package com.orderly;',
    '',
    'import com.orderly.service.VoucherService;',
    'import com.orderly.util.WindowHelper;',
    '',
    'public class VoucherController {',
    '  private final VoucherService voucherService;',
    '',
    '  public String handle(long userId) {',
    '    return "old";',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/service/VoucherService.java': [
    'package com.orderly.service;',
    '',
    'public interface VoucherService {',
    '  String generateWindow(long userId);',
    '}',
    '',
  ].join('\n'),
  'src/service/VoucherServiceImpl.java': [
    'package com.orderly.service;',
    '',
    'import com.orderly.util.WindowHelper;',
    '',
    'public class VoucherServiceImpl implements VoucherService {',
    '  @Override',
    '  public String generateWindow(long userId) {',
    '    return WindowHelper.formatId(userId);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/util/WindowHelper.java': [
    'package com.orderly.util;',
    '',
    'public class WindowHelper {',
    '  public static String formatId(long userId) {',
    '    return "W-" + userId;',
    '  }',
    '}',
    '',
  ].join('\n'),
}

const WORKING: Record<string, string> = {
  ...COMMITTED,
  'src/VoucherController.java': [
    'package com.orderly;',
    '',
    'import com.orderly.service.VoucherService;',
    'import com.orderly.util.WindowHelper;',
    '',
    'public class VoucherController {',
    '  private final VoucherService voucherService;',
    '',
    '  public String handle(long userId) {',
    '    String label = WindowHelper.formatId(userId);',
    '    String external = ExternalLib.missingMethod(label);',
    '    return voucherService.generateWindow(userId) + external;',
    '  }',
    '}',
    '',
  ].join('\n'),
}

const test = browserTest.extend<{ review: { url: string } }>({
  review: async ({ page }, provide) => {
    const { dir, home, env } = await makeRepo({ committed: COMMITTED, working: WORKING })
    const { proc, url } = await startCli(dir, ['--git'], env)
    try {
      await page.goto(url)
      await page.locator('.file-header').first().waitFor()
      await provide({ url })
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

/** Computes the exact center of `token` on line `lineNumber` inside `container`. */
async function tokenCenter(
  page: Page,
  containerSelector: string,
  lineNumber: number,
  token: string,
): Promise<{ x: number; y: number }> {
  let pos: { x: number; y: number } | null = null
  await expect(async () => {
    pos = await page.evaluate(
      ({ sel, line, word }) => {
        const hosts = [...document.querySelectorAll(sel)]
        for (const host of hosts) {
          const sr = host.shadowRoot
          if (!sr) continue
          const rows = sr.querySelectorAll(`[data-content] > [data-line="${line}"]`)
          for (const row of rows) {
            const text = row.textContent ?? ''
            const start = text.indexOf(word)
            if (start < 0) continue
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
            let rem = start + Math.floor(word.length / 2)
            let node: Text | null = null
            while ((node = walker.nextNode() as Text | null)) {
              if (rem < node.length) {
                const range = document.createRange()
                range.setStart(node, rem)
                range.setEnd(node, rem + 1)
                const rect = range.getBoundingClientRect()
                if (rect.width > 0 && rect.height > 0) {
                  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                }
              }
              rem -= node.length
            }
          }
        }
        return null
      },
      { sel: containerSelector, line: lineNumber, word: token },
    )
    expect(pos).not.toBeNull()
  }).toPass()
  return pos!
}

const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control'

async function modClick(page: Page, pos: { x: number; y: number }) {
  await page.keyboard.down(MODIFIER)
  try {
    await page.mouse.move(pos.x, pos.y)
    await page.mouse.click(pos.x, pos.y)
  } finally {
    await page.keyboard.up(MODIFIER)
  }
}

test('Cmd/Ctrl+Click jumps directly on single match, shows popover on multiple, and navigates back/forward', async ({
  page,
  review: _review,
}) => {
  // 1. Single definition: Cmd/Ctrl+Click `formatId` in DiffView -> jumps straight to WindowHelper.java
  const formatPos = await tokenCenter(page, 'diffs-container', 10, 'formatId')
  await modClick(page, formatPos)

  await expect(page.locator('.repo-file-header .file-header-path')).toHaveText(
    'src/util/WindowHelper.java',
  )
  await expect(page.getByRole('button', { name: 'Navigate back' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Navigate forward' })).toBeDisabled()

  // 2. Navigate Back returns to DiffView and enables Forward
  await page.getByRole('button', { name: 'Navigate back' }).click()
  await expect(page.locator('.diff-body')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Navigate forward' })).toBeEnabled()

  // 3. Multiple definitions: Cmd/Ctrl+Click `generateWindow` -> opens popover with interface + impl
  const genPos = await tokenCenter(page, 'diffs-container', 12, 'generateWindow')
  await modClick(page, genPos)

  const popover = page.locator('.symbol-popover')
  await expect(popover).toBeVisible()
  await expect(popover.locator('.symbol-popover-loc')).toHaveText([
    'src/service/VoucherService.java:4',
    'src/service/VoucherServiceImpl.java:7',
  ])

  // Select second definition (VoucherServiceImpl) via keyboard ArrowDown + Enter
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(popover).toBeHidden()
  await expect(page.locator('.repo-file-header .file-header-path')).toHaveText(
    'src/service/VoucherServiceImpl.java',
  )

  // 4. Jump from FilesView (`WindowHelper` inside VoucherServiceImpl.java) and go back via Alt+ArrowLeft
  const helperPos = await tokenCenter(
    page,
    '.repo-codeview diffs-container',
    8,
    'WindowHelper',
  )
  await modClick(page, helperPos)
  await expect(page.locator('.repo-file-header .file-header-path')).toHaveText(
    'src/util/WindowHelper.java',
  )

  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page.locator('.repo-file-header .file-header-path')).toHaveText(
    'src/service/VoucherServiceImpl.java',
  )

  await page.keyboard.press('Alt+ArrowRight')
  await expect(page.locator('.repo-file-header .file-header-path')).toHaveText(
    'src/util/WindowHelper.java',
  )

  // 5. Return to DiffView and verify missing external symbol shows toast without opening composer
  await page.keyboard.press('Alt+ArrowLeft')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page.locator('.diff-body')).toBeVisible()

  const missingPos = await tokenCenter(page, 'diffs-container', 11, 'missingMethod')
  await modClick(page, missingPos)
  await expect(page.locator('.symbol-toast')).toContainText(
    'No definition found for missingMethod in repository',
  )
  await expect(page.locator('.comment-form')).toHaveCount(0)
})
