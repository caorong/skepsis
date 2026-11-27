/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// Extracting the identifier under a pointer inside `@pierre/diffs`'s open
// shadow roots, for Cmd/Ctrl+Click go-to-definition.

const IDENT_CHAR = /[A-Za-z0-9_$]/
const IDENT_START = /[A-Za-z_$]/

const SKIP_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'throw',
  'throws',
  'try',
  'catch',
  'finally',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'void',
  'in',
  'of',
  'as',
  'is',
  'from',
  'import',
  'export',
  'package',
  'class',
  'interface',
  'enum',
  'record',
  'struct',
  'trait',
  'type',
  'extends',
  'implements',
  'public',
  'private',
  'protected',
  'static',
  'final',
  'abstract',
  'synchronized',
  'volatile',
  'transient',
  'native',
  'readonly',
  'override',
  'const',
  'let',
  'var',
  'val',
  'function',
  'async',
  'await',
  'yield',
  'def',
  'fn',
  'fun',
  'func',
  'pub',
  'mut',
  'true',
  'false',
  'null',
  'undefined',
  'nil',
  'None',
  'True',
  'False',
  'this',
  'super',
  'self',
  'boolean',
  'bool',
  'int',
  'long',
  'short',
  'byte',
  'char',
  'float',
  'double',
  'string',
  'number',
  'any',
  'unknown',
  'never',
  'object',
])

export interface ExtractedSymbol {
  symbol: string
  start: number
  end: number
  receiver: string | null
  isCall: boolean
}

/**
 * Extracts the identifier spanning `column` in `lineText`, together with an
 * immediate member receiver (`foo.bar` -> `foo`) and whether it is invoked
 * (`bar(` or `bar<T>(`).
 */
export function extractSymbolAtColumn(
  lineText: string,
  column: number,
): ExtractedSymbol | null {
  if (!lineText || column < 0 || column > lineText.length) return null
  let pos = column
  if (pos === lineText.length || !IDENT_CHAR.test(lineText[pos]!)) {
    if (pos > 0 && IDENT_CHAR.test(lineText[pos - 1]!)) pos -= 1
    else return null
  }

  let start = pos
  while (start > 0 && IDENT_CHAR.test(lineText[start - 1]!)) start -= 1
  let end = pos + 1
  while (end < lineText.length && IDENT_CHAR.test(lineText[end]!)) end += 1

  const symbol = lineText.slice(start, end)
  if (symbol.length < 2 || !IDENT_START.test(symbol[0]!) || SKIP_KEYWORDS.has(symbol)) {
    return null
  }

  // Check for immediate receiver: `<ident>.symbol`, `<ident>?.symbol`, `<ident>::symbol`
  let receiver: string | null = null
  let back = start - 1
  while (back >= 0 && /\s/.test(lineText[back]!)) back -= 1
  let sepLen = 0
  if (back >= 0 && lineText[back] === '.') {
    sepLen = back > 0 && lineText[back - 1] === '?' ? 2 : 1
  } else if (back >= 1 && lineText[back] === ':' && lineText[back - 1] === ':') {
    sepLen = 2
  }
  if (sepLen > 0) {
    let rEnd = back - sepLen + 1
    while (rEnd > 0 && /\s/.test(lineText[rEnd - 1]!)) rEnd -= 1
    let rStart = rEnd
    while (rStart > 0 && IDENT_CHAR.test(lineText[rStart - 1]!)) rStart -= 1
    const candidate = lineText.slice(rStart, rEnd)
    if (candidate && IDENT_START.test(candidate[0]!)) {
      receiver = candidate
    }
  }

  // Check if followed by `(` or `<...>(`, indicating a call/constructor invocation
  let fwd = end
  while (fwd < lineText.length && /\s/.test(lineText[fwd]!)) fwd += 1
  if (lineText[fwd] === '<') {
    let depth = 0
    while (fwd < lineText.length) {
      const ch = lineText[fwd]!
      if (ch === '<') depth += 1
      else if (ch === '>') {
        depth -= 1
        if (depth === 0) {
          fwd += 1
          break
        }
      }
      fwd += 1
    }
    while (fwd < lineText.length && /\s/.test(lineText[fwd]!)) fwd += 1
  }
  const isCall = lineText[fwd] === '('

  return { symbol, start, end, receiver, isCall }
}

export interface PointSymbol extends ExtractedSymbol {
  host: Element
  line: number
  range: Range
  rect: DOMRect
}

type CaretPositionLike = { offsetNode: Node; offset: number }
type DocumentWithCaret = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
    options?: { shadowRoots?: ShadowRoot[] },
  ) => CaretPositionLike | null
}

function columnInRow(row: Element, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(row, 0)
  range.setEnd(node, offset)
  return range.toString().length
}

function rangeForColumns(row: Element, startCol: number, endCol: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let remainingStart = startCol
  let remainingEnd = endCol
  let startPos: [Text, number] | null = null
  let endPos: [Text, number] | null = null
  let node: Text | null = null
  while ((node = walker.nextNode() as Text | null)) {
    const len = node.length
    if (!startPos && remainingStart <= len) {
      startPos = [node, remainingStart]
    }
    if (!endPos && remainingEnd <= len) {
      endPos = [node, remainingEnd]
      break
    }
    remainingStart -= len
    remainingEnd -= len
  }
  if (!startPos || !endPos) return null
  const range = document.createRange()
  range.setStart(startPos[0], startPos[1])
  range.setEnd(endPos[0], endPos[1])
  return range
}

function columnAtPointInRow(
  row: Element,
  shadowRoot: ShadowRoot,
  clientX: number,
  clientY: number,
): number | null {
  const doc = document as DocumentWithCaret
  const caret = doc.caretPositionFromPoint?.(clientX, clientY, {
    shadowRoots: [shadowRoot],
  })
  if (caret && row.contains(caret.offsetNode)) {
    return columnInRow(row, caret.offsetNode, caret.offset)
  }

  // Fallback for browsers without shadow-aware caretPositionFromPoint: locate
  // the character bounding rect inside the line's text nodes.
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  const probe = document.createRange()
  let col = 0
  let node: Text | null = null
  while ((node = walker.nextNode() as Text | null)) {
    const len = node.length
    if (len > 0) {
      probe.setStart(node, 0)
      probe.setEnd(node, len)
      const rects = probe.getClientRects()
      let hitsNode = false
      for (let r = 0; r < rects.length; r++) {
        const rect = rects[r]!
        if (
          clientY >= rect.top - 2 &&
          clientY <= rect.bottom + 2 &&
          clientX >= rect.left - 2 &&
          clientX <= rect.right + 2
        ) {
          hitsNode = true
          break
        }
      }
      if (hitsNode) {
        for (let i = 0; i < len; i++) {
          probe.setStart(node, i)
          probe.setEnd(node, i + 1)
          const rect = probe.getBoundingClientRect()
          if (
            rect.width > 0 &&
            clientY >= rect.top - 2 &&
            clientY <= rect.bottom + 2 &&
            clientX >= rect.left - 1 &&
            clientX <= rect.right + 1
          ) {
            return col + i
          }
        }
      }
    }
    col += len
  }
  return null
}

/**
 * Resolves the code symbol directly under `(clientX, clientY)` across the
 * given `diffs-container` hosts.
 */
export function symbolAtPoint(
  hosts: Element[],
  clientX: number,
  clientY: number,
): PointSymbol | null {
  for (const host of hosts) {
    const sr = host.shadowRoot
    if (!sr) continue
    const box = host.getBoundingClientRect()
    if (
      clientX < box.left ||
      clientX > box.right ||
      clientY < box.top ||
      clientY > box.bottom
    ) {
      continue
    }
    const el = sr.elementFromPoint(clientX, clientY)
    const row = el?.closest('[data-content] > [data-line]')
    if (!row) continue
    const lineNum = Number(row.getAttribute('data-line'))
    if (!Number.isInteger(lineNum) || lineNum < 1) continue

    const col = columnAtPointInRow(row, sr, clientX, clientY)
    if (col === null) continue

    const lineText = (row.textContent ?? '').replace(/\n$/, '')
    const extracted = extractSymbolAtColumn(lineText, col)
    if (!extracted) continue

    const range = rangeForColumns(row, extracted.start, extracted.end)
    if (!range) continue

    const rect = range.getBoundingClientRect()
    // Ensure pointer is actually on the token (not far past end-of-line whitespace)
    if (
      rect.width === 0 ||
      clientX < rect.left - 4 ||
      clientX > rect.right + 4 ||
      clientY < rect.top - 4 ||
      clientY > rect.bottom + 4
    ) {
      continue
    }

    return {
      ...extracted,
      host,
      line: lineNum,
      range,
      rect,
    }
  }
  return null
}
