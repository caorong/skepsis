/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRepositoryFiles } from './repositoryFiles.ts'
import {
  classifyDefinitionLine,
  extractFileContext,
  resolveSymbolDefinitions,
} from './symbolDefinition.ts'
import { isolateVcsConfig, run } from './testUtil.ts'

describe('classifyDefinitionLine', () => {
  it('recognizes Java classes, interfaces, methods, constructors, and constants', () => {
    expect(
      classifyDefinitionLine(
        'public class VoucherServiceImpl implements VoucherService {',
        'VoucherServiceImpl',
        'src/VoucherServiceImpl.java',
      ),
    ).toBe('type')
    expect(
      classifyDefinitionLine(
        'public interface VoucherService {',
        'VoucherService',
        'src/VoucherService.java',
      ),
    ).toBe('type')
    expect(
      classifyDefinitionLine(
        '  public WindowResult generateWindow(long userId) {',
        'generateWindow',
        'src/VoucherServiceImpl.java',
      ),
    ).toBe('method')
    expect(
      classifyDefinitionLine(
        '  WindowResult generateWindow(long userId);',
        'generateWindow',
        'src/VoucherService.java',
      ),
    ).toBe('method')
    expect(
      classifyDefinitionLine(
        '  public VoucherServiceImpl(Clock clock) {',
        'VoucherServiceImpl',
        'src/VoucherServiceImpl.java',
      ),
    ).toBe('method')
    expect(
      classifyDefinitionLine(
        '  public static final int MAX_WINDOW = 100;',
        'MAX_WINDOW',
        'src/VoucherServiceImpl.java',
      ),
    ).toBe('const')
  })

  it('rejects comments, control statements, and call sites', () => {
    expect(
      classifyDefinitionLine(
        '  // generateWindow calculates the next window',
        'generateWindow',
        'src/VoucherServiceImpl.java',
      ),
    ).toBeNull()
    expect(
      classifyDefinitionLine(
        '  return voucherService.generateWindow(userId);',
        'generateWindow',
        'src/VoucherController.java',
      ),
    ).toBeNull()
    expect(
      classifyDefinitionLine(
        '  if (generateWindow(userId)) {',
        'generateWindow',
        'src/VoucherController.java',
      ),
    ).toBeNull()
    expect(
      classifyDefinitionLine(
        '  var result = generateWindow(userId);',
        'generateWindow',
        'src/VoucherController.java',
      ),
    ).toBeNull()
  })

  it('recognizes TypeScript, Go, Python, and Rust definitions', () => {
    expect(
      classifyDefinitionLine(
        'export async function fetchOrder(id: string) {',
        'fetchOrder',
        'a.ts',
      ),
    ).toBe('function')
    expect(
      classifyDefinitionLine(
        'export const computeFee = (x: number) => x * 2',
        'computeFee',
        'a.ts',
      ),
    ).toBe('function')
    expect(classifyDefinitionLine('export interface OrderRow {', 'OrderRow', 'a.ts')).toBe(
      'type',
    )
    expect(
      classifyDefinitionLine(
        'func (s *Store) Compute(id string) error {',
        'Compute',
        'a.go',
      ),
    ).toBe('method')
    expect(classifyDefinitionLine('def compute_fee(amount):', 'compute_fee', 'a.py')).toBe(
      'function',
    )
    expect(
      classifyDefinitionLine('pub fn compute_fee(x: u64) -> u64 {', 'compute_fee', 'a.rs'),
    ).toBe('function')
  })
})

describe('extractFileContext', () => {
  it('extracts Java imports and infers receiver class names', () => {
    const java = `package com.orderly.voucher;

import com.orderly.voucher.service.VoucherService;
import static com.orderly.voucher.util.MathUtil.clampBalance;

public class VoucherController {
  private final VoucherService voucherService;

  public void run(long userId) {
    var calc = new BalanceCalculator();
    voucherService.generateWindow(userId);
    clampBalance(10);
  }
}
`
    const ctx = extractFileContext(
      java,
      'src/main/java/com/orderly/voucher/VoucherController.java',
      'generateWindow',
      'voucherService',
    )
    expect([...ctx.importedPaths]).toContain(
      'com/orderly/voucher/service/VoucherService.java',
    )
    expect([...ctx.receiverTypes]).toContain('VoucherService')

    const staticCtx = extractFileContext(
      java,
      'src/main/java/com/orderly/voucher/VoucherController.java',
      'clampBalance',
    )
    expect([...staticCtx.symbolImportSuffixes]).toContain(
      'com/orderly/voucher/util/MathUtil.java',
    )

    const ctorCtx = extractFileContext(
      java,
      'src/main/java/com/orderly/voucher/VoucherController.java',
      'run',
      'calc',
    )
    expect([...ctorCtx.receiverTypes]).toContain('BalanceCalculator')
  })
})

describe('resolveSymbolDefinitions', () => {
  let home: string
  let tmp: string
  let repo: string

  beforeAll(async () => {
    home = await isolateVcsConfig()
    tmp = await mkdtemp(join(tmpdir(), 'skepsis-symbol-def-'))
    repo = join(tmp, 'repo')
    await run('git', ['init', '-q', repo], tmp)

    const files: Record<string, string> = {
      'src/main/java/com/orderly/voucher/VoucherController.java': [
        'package com.orderly.voucher;',
        '',
        'import com.orderly.voucher.service.VoucherService;',
        '',
        'public class VoucherController {',
        '  private final VoucherService voucherService;',
        '',
        '  public String handle(long userId) {',
        '    validateUser(userId);',
        '    return voucherService.generateWindow(userId);',
        '  }',
        '',
        '  private void validateUser(long userId) {',
        '    if (userId <= 0) throw new IllegalArgumentException();',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/main/java/com/orderly/voucher/service/VoucherService.java': [
        'package com.orderly.voucher.service;',
        '',
        'public interface VoucherService {',
        '  String generateWindow(long userId);',
        '}',
        '',
      ].join('\n'),
      'src/main/java/com/orderly/voucher/service/VoucherServiceImpl.java': [
        'package com.orderly.voucher.service;',
        '',
        'public class VoucherServiceImpl implements VoucherService {',
        '  @Override',
        '  public String generateWindow(long userId) {',
        '    return "ok";',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/test/java/com/orderly/voucher/VoucherServiceTest.java': [
        'package com.orderly.voucher;',
        '',
        'public class VoucherServiceTest {',
        '  public String generateWindow(long userId) {',
        '    return "mock";',
        '  }',
        '}',
        '',
      ].join('\n'),
      'web/helper.ts': [
        'export function formatAmount(value: number): string {',
        '  return value.toFixed(2)',
        '}',
        '',
      ].join('\n'),
      'web/caller.ts': [
        "import { formatAmount } from './helper'",
        '',
        'export const label = formatAmount(42)',
        '',
      ].join('\n'),
    }

    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        const full = join(repo, rel)
        await mkdir(join(full, '..'), { recursive: true })
        await writeFile(full, content)
      }),
    )
    await run('git', ['add', '.'], repo)
    await run('git', ['commit', '-qm', 'init'], repo)
  })

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true })
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('resolves imported Java type directly', async () => {
    const repository = createRepositoryFiles(repo, 'git')
    const res = await resolveSymbolDefinitions({
      root: repo,
      symbol: 'VoucherService',
      fromFile: 'src/main/java/com/orderly/voucher/VoucherController.java',
      line: 6,
      isCall: false,
      paths: repository.paths,
      read: repository.read,
    })
    expect(res.definitions[0]).toMatchObject({
      path: 'src/main/java/com/orderly/voucher/service/VoucherService.java',
      line: 3,
      kind: 'type',
      reason: 'imported',
    })
  })

  it('ranks inferred receiver interface + impl ahead of test mocks', async () => {
    const repository = createRepositoryFiles(repo, 'git')
    const res = await resolveSymbolDefinitions({
      root: repo,
      symbol: 'generateWindow',
      fromFile: 'src/main/java/com/orderly/voucher/VoucherController.java',
      receiver: 'voucherService',
      line: 10,
      isCall: true,
      paths: repository.paths,
      read: repository.read,
    })
    expect(res.definitions.map((d) => d.path)).toEqual([
      'src/main/java/com/orderly/voucher/service/VoucherService.java',
      'src/main/java/com/orderly/voucher/service/VoucherServiceImpl.java',
      'src/test/java/com/orderly/voucher/VoucherServiceTest.java',
    ])
    expect(res.definitions[0]?.reason).toBe('target type')
    expect(res.definitions[1]?.reason).toBe('target type')
  })

  it('resolves same-file methods and TypeScript relative imports', async () => {
    const repository = createRepositoryFiles(repo, 'git')
    const sameFile = await resolveSymbolDefinitions({
      root: repo,
      symbol: 'validateUser',
      fromFile: 'src/main/java/com/orderly/voucher/VoucherController.java',
      line: 9,
      isCall: true,
      paths: repository.paths,
      read: repository.read,
    })
    expect(sameFile.definitions).toHaveLength(1)
    expect(sameFile.definitions[0]).toMatchObject({
      path: 'src/main/java/com/orderly/voucher/VoucherController.java',
      line: 13,
      kind: 'method',
      reason: 'same file',
    })

    const tsImport = await resolveSymbolDefinitions({
      root: repo,
      symbol: 'formatAmount',
      fromFile: 'web/caller.ts',
      line: 3,
      isCall: true,
      paths: repository.paths,
      read: repository.read,
    })
    expect(tsImport.definitions[0]).toMatchObject({
      path: 'web/helper.ts',
      line: 1,
      kind: 'function',
      reason: 'imported',
    })
  })

  it('falls back cleanly to git grep when rg is unavailable', async () => {
    const repository = createRepositoryFiles(repo, 'git')
    const res = await resolveSymbolDefinitions({
      root: repo,
      symbol: 'generateWindow',
      fromFile: 'src/main/java/com/orderly/voucher/VoucherController.java',
      receiver: 'voucherService',
      line: 10,
      isCall: true,
      paths: repository.paths,
      read: repository.read,
      rgBinary: '/nonexistent/rg-binary',
    })
    expect(res.definitions.length).toBeGreaterThanOrEqual(2)
    expect(res.definitions[0]?.path).toBe(
      'src/main/java/com/orderly/voucher/service/VoucherService.java',
    )
  })

  it('returns empty definitions for external library symbols', async () => {
    const repository = createRepositoryFiles(repo, 'git')
    const res = await resolveSymbolDefinitions({
      root: repo,
      symbol: 'addDataSourceProperty',
      fromFile: 'src/main/java/com/orderly/voucher/VoucherController.java',
      receiver: 'pool',
      line: 10,
      isCall: true,
      paths: repository.paths,
      read: repository.read,
    })
    expect(res.definitions).toEqual([])
  })
})
