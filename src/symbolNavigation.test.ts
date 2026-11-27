/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { extractSymbolAtColumn } from './symbolNavigation.ts'

describe('extractSymbolAtColumn', () => {
  it('extracts method calls with member receivers', () => {
    const line = '    return voucherService.generateWindow(userId);'
    const col = line.indexOf('generateWindow') + 3
    expect(extractSymbolAtColumn(line, col)).toEqual({
      symbol: 'generateWindow',
      start: line.indexOf('generateWindow'),
      end: line.indexOf('generateWindow') + 'generateWindow'.length,
      receiver: 'voucherService',
      isCall: true,
    })
  })

  it('extracts types, static calls, optional chaining, and generic calls', () => {
    const line1 = '  private final VoucherService voucherService;'
    expect(extractSymbolAtColumn(line1, line1.indexOf('VoucherService'))).toMatchObject({
      symbol: 'VoucherService',
      receiver: null,
      isCall: false,
    })

    const line2 = '  items.stream().map(VoucherUtils::formatWindow)'
    expect(extractSymbolAtColumn(line2, line2.indexOf('formatWindow'))).toMatchObject({
      symbol: 'formatWindow',
      receiver: 'VoucherUtils',
      isCall: false,
    })

    const line3 = '  const out = client?.parseResponse<OrderRow>(raw)'
    expect(extractSymbolAtColumn(line3, line3.indexOf('parseResponse') + 2)).toMatchObject({
      symbol: 'parseResponse',
      receiver: 'client',
      isCall: true,
    })
  })

  it('ignores keywords and single-character identifiers', () => {
    const line = '  for (int i = 0; i < 10; i++) return null;'
    expect(extractSymbolAtColumn(line, line.indexOf('for'))).toBeNull()
    expect(extractSymbolAtColumn(line, line.indexOf('return'))).toBeNull()
    expect(extractSymbolAtColumn(line, line.indexOf(' i ') + 1)).toBeNull()
  })
})
