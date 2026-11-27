/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, posix } from 'node:path'
import { promisify } from 'node:util'
import type {
  RepositoryFile,
  SymbolDefinition,
  SymbolDefinitionKind,
  SymbolDefinitionsResponse,
} from '../shared/types.ts'
import { sourceLines } from './repositoryFiles.ts'

const exec = promisify(execFile)
const MAX_SEARCH_BUFFER = 4 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 4_000
const MAX_RESULTS = 20
const MAX_DIRECT_CANDIDATE_FILES = 6

const NON_TYPE_KEYWORDS = new Set([
  'return',
  'throw',
  'throws',
  'new',
  'case',
  'yield',
  'await',
  'typeof',
  'delete',
  'else',
  'do',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'try',
  'assert',
  'package',
  'import',
  'export',
  'default',
  'extends',
  'implements',
  'instanceof',
  'in',
  'of',
  'as',
  'is',
  'from',
])

const JAVA_LIKE_EXTS = new Set(['.java', '.kt', '.kts', '.cs', '.scala', '.groovy'])
const TS_LIKE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
const GO_EXTS = new Set(['.go'])
const RUST_EXTS = new Set(['.rs'])
const PYTHON_EXTS = new Set(['.py', '.pyi'])
const C_LIKE_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fileStem(path: string): string {
  const base = basename(path)
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

function isTestPath(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    /(?:^|\/)(?:test|tests|__tests__|e2e|spec|specs)\//.test(lower) ||
    /(?:test|tests|spec|e2e)\.[a-z0-9]+$/.test(lower) ||
    /\.(?:test|spec|e2e)\.[a-z0-9]+$/.test(lower)
  )
}

function topModule(path: string): string {
  const idx = path.indexOf('/')
  return idx > 0 ? path.slice(0, idx) : ''
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed === '' ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('--') ||
    trimmed.startsWith('<!--')
  )
}

/**
 * Classifies whether a single source line declares `symbol`, rejecting call
 * sites, control-flow statements, comments, and member accesses.
 */
export function classifyDefinitionLine(
  rawLine: string,
  symbol: string,
  path: string,
): SymbolDefinitionKind | null {
  const trimmed = rawLine.trim()
  if (isCommentLine(trimmed)) return null

  const esc = escapeRegExp(symbol)
  const ext = extname(path).toLowerCase()
  const stem = fileStem(path)

  // Reject lines where symbol only appears inside a trailing comment.
  const codeOnly = trimmed.replace(/\s\/\/.*$/, '').trim()
  if (!new RegExp(`\\b${esc}\\b`).test(codeOnly)) return null

  // 1. Type declarations across all common languages
  if (
    new RegExp(
      `\\b(?:@?interface|class|enum|record|struct|trait|protocol|object|type)\\s+${esc}\\b`,
    ).test(codeOnly)
  ) {
    // Exclude Java/TS expressions like `Foo.class` or `typeof Foo`
    if (!new RegExp(`\\.${esc}\\b`).test(codeOnly)) {
      return 'type'
    }
  }

  // 2. Keyword-prefixed functions/methods: TS/JS/Go/Rust/Python/Kotlin/Swift
  if (
    new RegExp(
      `\\b(?:function\\s*\\*?|def|fn|fun|func)\\s+(?:\\([^)]*\\)\\s+)?${esc}\\b`,
    ).test(codeOnly)
  ) {
    return GO_EXTS.has(ext) && /\bfunc\s+\(/.test(codeOnly) ? 'method' : 'function'
  }

  // 3. Language-specific declarations
  if (JAVA_LIKE_EXTS.has(ext) || C_LIKE_EXTS.has(ext)) {
    // Constructor: `public MyClass(...)` or `MyClass(...) {` inside MyClass.java
    const ctorMatch = new RegExp(
      `^(?:(?:public|protected|private|internal)\\s+)?${esc}\\s*\\(`,
    ).exec(codeOnly)
    if (ctorMatch && stem === symbol && !/=\s*/.test(codeOnly.slice(0, ctorMatch.index))) {
      return 'method'
    }

    // Method with explicit return type (and optional modifiers/generics) before `symbol(`
    const methodMatch = new RegExp(`^(.+?)\\s+${esc}\\s*\\(`).exec(codeOnly)
    if (methodMatch) {
      const before = methodMatch[1]!.trim()
      // Must not be a call expression or control statement
      if (
        before &&
        !/[=.(?:+\-*/%&|^!~,<]$/.test(before) &&
        !before.includes('=') &&
        !before.includes('->') &&
        !before.includes('::')
      ) {
        const lastWord = before.match(
          /([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>\n]*>)?(?:\[\])?$/,
        )?.[1]
        if (lastWord && !NON_TYPE_KEYWORDS.has(lastWord)) {
          // Reject lines that clearly look like `if (x) foo()` or `return foo()`
          const firstWord = before.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/)?.[1]
          if (!firstWord || !NON_TYPE_KEYWORDS.has(firstWord)) {
            return 'method'
          }
        }
      }
    }

    // Constant / field declaration (e.g. `private static final int MAX_SIZE = 10;`)
    const fieldMatch = new RegExp(
      `^(?:(?:public|protected|private|static|final|volatile|transient|readonly|const|val|var)\\s+)+(?:[A-Za-z_$][A-Za-z0-9_$.<>, ?\\[\\]]*\\s+)?${esc}\\s*(?:=|;|,)`,
    ).exec(codeOnly)
    if (fieldMatch) {
      return /\b(?:final|const|val)\b/.test(codeOnly) ? 'const' : 'field'
    }

    // Enum constant on its own line (e.g. `ACTIVE,` or `ACTIVE("active"),`)
    if (
      new RegExp(`^${esc}\\s*(?:\\([^)]*\\))?\\s*[,;]?$`).test(codeOnly) &&
      /^[A-Z][A-Z0-9_]*$/.test(symbol)
    ) {
      return 'const'
    }
  }

  if (TS_LIKE_EXTS.has(ext)) {
    // `export const foo = ...`, `let foo = ...`, `declare function foo`
    const varDecl = new RegExp(
      `^(?:export\\s+)?(?:declare\\s+)?(const|let|var)\\s+${esc}\\b\\s*(?::[^=]+)?=`,
    ).exec(codeOnly)
    if (varDecl) {
      const rhs = codeOnly.slice(varDecl.index + varDecl[0].length).trim()
      if (
        /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^function\b/.test(rhs)
      ) {
        return 'function'
      }
      return 'const'
    }

    // Class / object method: `async foo(a: string): Promise<void> {` or `foo(a) {`
    const methodRe = new RegExp(
      `^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\\s+)*#?${esc}\\s*(?:<[^>\n]*>)?\\s*\\(`,
    )
    if (methodRe.test(codeOnly) && !NON_TYPE_KEYWORDS.has(symbol)) {
      // Require either modifiers, return type `:`, or opening `{` so bare `foo(x)` calls don't match
      if (
        /^(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+/.test(
          codeOnly,
        ) ||
        /\)\s*(?::\s*[^=;]+)?\s*\{/.test(codeOnly)
      ) {
        return 'method'
      }
    }

    // Object property function: `foo: (x) =>` or `foo: function`
    if (
      new RegExp(`^${esc}\\s*:\\s*(?:async\\s+)?(?:\\([^)]*\\)\\s*=>|function\\b)`).test(
        codeOnly,
      )
    ) {
      return 'function'
    }

    // Interface / class field property: `readonly foo?: string` or `foo: Bar`
    if (
      new RegExp(
        `^(?:(?:public|private|protected|static|readonly|override)\\s+)*#?${esc}\\??\\s*:\\s*[^=]`,
      ).test(codeOnly) &&
      !codeOnly.endsWith(',')
    ) {
      return 'field'
    }
  }

  if (GO_EXTS.has(ext)) {
    if (new RegExp(`^(?:const|var)\\s+${esc}\\b`).test(codeOnly)) return 'const'
    if (
      new RegExp(`^\\s*${esc}\\s+[A-Za-z_*\\[\\]]`).test(codeOnly) &&
      !codeOnly.includes(':=')
    ) {
      return 'field'
    }
  }

  if (RUST_EXTS.has(ext)) {
    if (
      new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+${esc}\\b`).test(
        codeOnly,
      )
    ) {
      return 'const'
    }
  }

  if (PYTHON_EXTS.has(ext)) {
    if (new RegExp(`^${esc}\\s*(?::[^=]+)?=`).test(codeOnly) && !rawLine.startsWith(' ')) {
      return 'const'
    }
  }

  // Fallback for other languages: explicit top-level `const/let/val/define SYMBOL =`
  if (new RegExp(`^(?:export\\s+)?(?:const|val|let|#define)\\s+${esc}\\b`).test(codeOnly)) {
    return 'const'
  }

  return null
}

export interface FileContext {
  /** Exact relative repo paths or path suffixes imported by `fromFile` (e.g. `com/foo/Bar.java`) */
  importedPaths: Set<string>
  /** Exact path suffixes imported specifically for `symbol` */
  symbolImportSuffixes: Set<string>
  /** Wildcard package prefixes like `com/orderly/voucher/` */
  wildcardPrefixes: Set<string>
  /** Candidate type names inferred for `receiver` (e.g. `VoucherService` for `voucherService.calc()`) */
  receiverTypes: Set<string>
  /** Superclass / interface names declared by `fromFile` (helpful for `this`/`super`) */
  superTypes: Set<string>
}

export function extractFileContext(
  contents: string,
  fromFile: string,
  symbol: string,
  receiver?: string,
): FileContext {
  const importedPaths = new Set<string>()
  const symbolImportSuffixes = new Set<string>()
  const wildcardPrefixes = new Set<string>()
  const receiverTypes = new Set<string>()
  const superTypes = new Set<string>()

  const ext = extname(fromFile).toLowerCase()
  const fromDir = dirname(fromFile)
  const lines = sourceLines(contents)

  if (JAVA_LIKE_EXTS.has(ext)) {
    const typeExt = ext === '.kt' || ext === '.kts' ? '.kt' : '.java'
    for (const line of lines) {
      const m = /^\s*import\s+(static\s+)?([A-Za-z0-9_.*]+)\s*;?/.exec(line)
      if (!m) continue
      const isStatic = !!m[1]
      const target = m[2]!
      if (target.endsWith('.*')) {
        const pkg = target.slice(0, -2).replaceAll('.', '/')
        wildcardPrefixes.add(`${pkg}/`)
        continue
      }
      const parts = target.split('.')
      if (isStatic && parts.length >= 2) {
        const member = parts.at(-1)!
        const classPath = `${parts.slice(0, -1).join('/')}${typeExt}`
        importedPaths.add(classPath)
        if (member === symbol) symbolImportSuffixes.add(classPath)
      } else {
        const className = parts.at(-1)!
        const classPath = `${parts.join('/')}${typeExt}`
        importedPaths.add(classPath)
        if (className === symbol) symbolImportSuffixes.add(classPath)
      }
    }

    // Superclass / implemented interfaces
    for (const m of contents.matchAll(
      /\b(?:extends|implements)\s+([A-Za-z0-9_$,\s<>]+?)(?:\{|where\b)/g,
    )) {
      for (const name of m[1]!.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
        superTypes.add(name[1]!)
      }
    }
  } else if (TS_LIKE_EXTS.has(ext)) {
    const resolveRel = (spec: string): string[] => {
      if (!spec.startsWith('.')) return []
      const joined = posix.normalize(posix.join(fromDir === '.' ? '' : fromDir, spec))
      if (extname(joined)) {
        const stem = joined.slice(0, -extname(joined).length)
        return [joined, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`]
      }
      return [
        `${joined}.ts`,
        `${joined}.tsx`,
        `${joined}.js`,
        `${joined}.jsx`,
        `${joined}/index.ts`,
        `${joined}/index.tsx`,
        `${joined}/index.js`,
      ]
    }

    for (const m of contents.matchAll(
      /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
    )) {
      const clause = m[1]!
      const spec = m[2]!
      const candidates = resolveRel(spec)
      for (const c of candidates) importedPaths.add(c)
      if (new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(clause)) {
        for (const c of candidates) symbolImportSuffixes.add(c)
      }
    }
  }

  // Infer receiver type from `fromFile`
  if (receiver) {
    if (receiver === 'this' || receiver === 'super' || receiver === 'self') {
      for (const st of superTypes) receiverTypes.add(st)
    } else if (/^[A-Z][A-Za-z0-9_]*$/.test(receiver)) {
      receiverTypes.add(receiver)
    } else {
      const rEsc = escapeRegExp(receiver)
      // Java/Kotlin/C#: `TypeName receiver`, `TypeName<T> receiver`, `final TypeName receiver`
      for (const m of contents.matchAll(
        new RegExp(
          `(?:^|[\\s(,;])(?:final\\s+)?([A-Z][A-Za-z0-9_]*)(?:<[^>\n]{1,120}>)?(?:\\[\\])?\\s+${rEsc}\\b`,
          'gm',
        ),
      )) {
        const candidate = m[1]!
        if (!NON_TYPE_KEYWORDS.has(candidate.toLowerCase())) receiverTypes.add(candidate)
      }
      // Constructor assignment: `receiver = new TypeName(`
      for (const m of contents.matchAll(
        new RegExp(`\\b${rEsc}\\s*=\\s*new\\s+([A-Z][A-Za-z0-9_]*)`, 'g'),
      )) {
        receiverTypes.add(m[1]!)
      }
      // TS/Python type annotation: `receiver: TypeName`
      for (const m of contents.matchAll(
        new RegExp(`\\b${rEsc}\\s*:\\s*(?:readonly\\s+)?([A-Z][A-Za-z0-9_]*)`, 'g'),
      )) {
        receiverTypes.add(m[1]!)
      }
      // Go declaration: `receiver *TypeName` or `receiver pkg.TypeName`
      for (const m of contents.matchAll(
        new RegExp(`\\b${rEsc}\\s+\\*?(?:[a-z0-9_]+\\.)?([A-Z][A-Za-z0-9_]*)`, 'g'),
      )) {
        receiverTypes.add(m[1]!)
      }
    }
  }

  return {
    importedPaths,
    symbolImportSuffixes,
    wildcardPrefixes,
    receiverTypes,
    superTypes,
  }
}

function macosRgCandidate(): string | null {
  if (process.platform !== 'darwin') return null
  for (const candidate of ['/opt/homebrew/bin/rg', '/usr/local/bin/rg']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

let cachedRgBinary: string | null | undefined

function parseSearchOutput(stdout: string) {
  const hits: { path: string; line: number; text: string }[] = []
  for (const row of stdout.split('\n')) {
    if (!row) continue
    const first = row.indexOf(':')
    if (first <= 0) continue
    const second = row.indexOf(':', first + 1)
    if (second <= first + 1) continue
    const path = row.slice(0, first)
    const line = Number(row.slice(first + 1, second))
    if (!Number.isInteger(line) || line < 1) continue
    hits.push({ path, line, text: row.slice(second + 1) })
  }
  return hits
}

async function runSearch(
  root: string,
  symbol: string,
  rgBinary?: string,
): Promise<{ path: string; line: number; text: string }[]> {
  const esc = escapeRegExp(symbol)
  // Rust-regex & POSIX-ERE friendly definition patterns so search stays fast even on huge repos.
  const rgPatterns = [
    `\\b(@?interface|class|enum|record|struct|trait|protocol|object|type)\\s+${esc}\\b`,
    `\\b(function\\s*\\*?|def|fn|fun|func)\\s+(\\([^)]*\\)\\s+)?${esc}\\b`,
    `^\\s*(export\\s+)?(declare\\s+)?(const|let|var|val|#define)\\s+${esc}\\b`,
    `\\b${esc}\\s*(<[^>\n]{1,120}>)?\\s*\\(`,
    `^\\s*(public|protected|private|static|final|readonly|const|val|var)\\s+.*\\b${esc}\\b`,
  ]
  const gitGrepPatterns = [
    `\\b(@?interface|class|enum|record|struct|trait|protocol|object|type)[[:space:]]+${esc}\\b`,
    `\\b(function[[:space:]]*\\*?|def|fn|fun|func)[[:space:]]+(\\([^)]*\\)[[:space:]]+)?${esc}\\b`,
    `^[[:space:]]*(export[[:space:]]+)?(declare[[:space:]]+)?(const|let|var|val|#define)[[:space:]]+${esc}\\b`,
    `\\b${esc}[[:space:]]*(<[^>]{1,120}>)?[[:space:]]*\\(`,
    `^[[:space:]]*(public|protected|private|static|final|readonly|const|val|var)[[:space:]]+.*\\b${esc}\\b`,
  ]

  const execRg = async (bin: string) => {
    const args = [
      '--no-heading',
      '--line-number',
      '--with-filename',
      '--color=never',
      '--no-messages',
      '--max-count=12',
      '--max-filesize=1M',
      ...rgPatterns.flatMap((p) => ['-e', p]),
      '--',
      '.',
    ]
    const { stdout } = await exec(bin, args, {
      cwd: root,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: MAX_SEARCH_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    })
    return parseSearchOutput(stdout)
  }

  type ExecFailure = { code?: number | string }

  const tryRg = async (): Promise<
    { path: string; line: number; text: string }[] | null
  > => {
    if (rgBinary) {
      try {
        return await execRg(rgBinary)
      } catch (err) {
        const failure = err as ExecFailure
        if (failure.code === 1) return []
        if (failure.code === 'ENOENT') return null
        return null
      }
    }
    if (cachedRgBinary === null) return null
    const bin = cachedRgBinary ?? 'rg'
    try {
      const result = await execRg(bin)
      cachedRgBinary = bin
      return result
    } catch (err) {
      const failure = err as ExecFailure
      if (failure.code === 1) {
        cachedRgBinary = bin
        return []
      }
      if (failure.code === 'ENOENT' && bin === 'rg') {
        const bundled = macosRgCandidate()
        if (bundled) {
          try {
            const result = await execRg(bundled)
            cachedRgBinary = bundled
            return result
          } catch (retryErr) {
            const retryFailure = retryErr as ExecFailure
            if (retryFailure.code === 1) {
              cachedRgBinary = bundled
              return []
            }
          }
        }
        cachedRgBinary = null
      }
      return null
    }
  }

  const rgResult = await tryRg()
  if (rgResult !== null) return rgResult

  // Fallback to `git grep` when `rg` is unavailable.
  try {
    const args = [
      'grep',
      '-n',
      '-E',
      '--no-color',
      '-I',
      ...gitGrepPatterns.flatMap((p) => ['-e', p]),
    ]
    const { stdout } = await exec('git', args, {
      cwd: root,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: MAX_SEARCH_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    })
    return parseSearchOutput(stdout)
  } catch (err) {
    const failure = err as ExecFailure
    if (failure.code === 1) return []
    return []
  }
}

function matchesSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`/${suffix}`)
}

function matchesAnySuffix(path: string, suffixes: ReadonlySet<string>): boolean {
  for (const s of suffixes) {
    if (matchesSuffix(path, s)) return true
  }
  return false
}

function matchesReceiverType(path: string, receiverTypes: ReadonlySet<string>): boolean {
  if (receiverTypes.size === 0) return false
  const stem = fileStem(path)
  for (const typeName of receiverTypes) {
    if (stem === typeName || stem === `${typeName}Impl` || stem === `Default${typeName}`) {
      return true
    }
  }
  return false
}

export interface ResolveSymbolOptions {
  root: string
  symbol: string
  fromFile?: string
  receiver?: string
  isCall?: boolean
  line?: number
  paths: () => Promise<string[]>
  read: (path: string) => Promise<RepositoryFile>
  rgBinary?: string
}

export async function resolveSymbolDefinitions(
  opts: ResolveSymbolOptions,
): Promise<SymbolDefinitionsResponse> {
  const { root, symbol, fromFile, receiver, isCall = false, line: fromLine } = opts
  const allPaths = await opts.paths()
  const pathSet = new Set(allPaths)

  const fromContents =
    fromFile && pathSet.has(fromFile)
      ? await opts.read(fromFile).then(
          (f) => f.contents,
          () => null,
        )
      : null

  const ctx: FileContext =
    fromContents !== null && fromFile
      ? extractFileContext(fromContents, fromFile, symbol, receiver)
      : {
          importedPaths: new Set(),
          symbolImportSuffixes: new Set(),
          wildcardPrefixes: new Set(),
          receiverTypes:
            receiver && /^[A-Z][A-Za-z0-9_]*$/.test(receiver)
              ? new Set([receiver])
              : new Set(),
          superTypes: new Set(),
        }

  const collected = new Map<
    string,
    { path: string; line: number; preview: string; kind: SymbolDefinitionKind }
  >()

  const addCandidate = (
    path: string,
    lineNum: number,
    rawText: string,
    kind: SymbolDefinitionKind,
  ) => {
    const key = `${path}:${lineNum}`
    if (collected.has(key)) return
    collected.set(key, {
      path,
      line: lineNum,
      preview: rawText.trim().slice(0, 180),
      kind,
    })
  }

  const scanFile = (path: string, contents: string) => {
    const lines = sourceLines(contents)
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!
      if (!text.includes(symbol)) continue
      const kind = classifyDefinitionLine(text, symbol, path)
      if (kind) addCandidate(path, i + 1, text, kind)
    }
  }

  // 1. Scan originating file directly (zero subprocess cost for same-file calls)
  if (fromContents !== null && fromFile) {
    scanFile(fromFile, fromContents)
  }

  // 2. Direct scan of high-confidence target files (exact imports, receiver class files, type files)
  const directFiles = new Set<string>()
  for (const p of allPaths) {
    if (p === fromFile) continue
    if (matchesAnySuffix(p, ctx.symbolImportSuffixes)) {
      directFiles.add(p)
    } else if (matchesReceiverType(p, ctx.receiverTypes)) {
      directFiles.add(p)
    } else if ((!isCall || /^[A-Z]/.test(symbol)) && fileStem(p) === symbol) {
      directFiles.add(p)
    }
  }

  const directList = [...directFiles].slice(0, MAX_DIRECT_CANDIDATE_FILES)
  await Promise.all(
    directList.map(async (p) => {
      const file = await opts.read(p).catch(() => null)
      if (file) scanFile(p, file.contents)
    }),
  )

  // Skip full-repo grep when we already found an exact imported type or same-file
  // receiver match and the user wasn't asking for an interface/multi-impl method.
  const hasExactImportedType =
    !isCall &&
    !receiver &&
    [...collected.values()].some(
      (hit) => hit.kind === 'type' && matchesAnySuffix(hit.path, ctx.symbolImportSuffixes),
    )

  if (!hasExactImportedType) {
    const rawHits = await runSearch(root, symbol, opts.rgBinary)
    for (const hit of rawHits) {
      const normalized = hit.path.replaceAll('\\', '/').replace(/^\.\//, '')
      if (!pathSet.has(normalized)) continue
      const kind = classifyDefinitionLine(hit.text, symbol, normalized)
      if (kind) addCandidate(normalized, hit.line, hit.text, kind)
    }
  }

  const fromDir = fromFile ? dirname(fromFile) : null
  const fromExt = fromFile ? extname(fromFile).toLowerCase() : null
  const fromMod = fromFile ? topModule(fromFile) : ''
  const fromIsTest = fromFile ? isTestPath(fromFile) : false

  const scored = [...collected.values()]
    // If other definitions exist, don't jump onto the exact line the user clicked.
    .filter(
      (hit) =>
        !(
          fromFile &&
          fromLine &&
          hit.path === fromFile &&
          hit.line === fromLine &&
          collected.size > 1
        ),
    )
    .map((hit) => {
      let score = 0
      let reason: string | undefined

      const isSameFile = fromFile !== undefined && hit.path === fromFile
      const isTargetType = matchesReceiverType(hit.path, ctx.receiverTypes)
      const isSymbolImported = matchesAnySuffix(hit.path, ctx.symbolImportSuffixes)
      const isFileImported = matchesAnySuffix(hit.path, ctx.importedPaths)
      const isWildcardPkg = [...ctx.wildcardPrefixes].some((prefix) =>
        hit.path.includes(`/${prefix}`),
      )

      if (isTargetType) {
        score += 130
        reason = 'target type'
      }
      if (isSymbolImported) {
        score += 120
        reason ??= 'imported'
      } else if (isFileImported) {
        score += 75
        reason ??= 'imported'
      }
      if (isSameFile) {
        score += receiver && receiver !== 'this' && receiver !== 'self' ? 35 : 95
        reason ??= 'same file'
      }
      if (!isCall && hit.kind === 'type') {
        score += 55
        if (fileStem(hit.path) === symbol) {
          score += 30
          reason ??= 'type file'
        }
      }
      if (isCall && (hit.kind === 'method' || hit.kind === 'function')) {
        score += 55
      }
      if (isCall && hit.kind === 'type') {
        // Constructor call like `new Foo()` or `Foo()`
        score += 20
      }
      if (fromDir && dirname(hit.path) === fromDir && !isSameFile) {
        score += 40
        reason ??= 'same package'
      } else if (isWildcardPkg) {
        score += 35
        reason ??= 'imported package'
      }
      if (fromMod && topModule(hit.path) === fromMod && !isSameFile) {
        score += 20
        reason ??= 'same module'
      }
      if (fromExt && extname(hit.path).toLowerCase() === fromExt) {
        score += 15
      }
      if (!fromIsTest && isTestPath(hit.path)) {
        score -= 35
      }

      return { hit, score, reason }
    })
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        a.hit.path.localeCompare(b.hit.path) ||
        a.hit.line - b.hit.line,
    )

  const truncated = scored.length > MAX_RESULTS
  const definitions: SymbolDefinition[] = scored
    .slice(0, MAX_RESULTS)
    .map(({ hit, reason }) => {
      const item: SymbolDefinition = {
        path: hit.path,
        line: hit.line,
        preview: hit.preview,
        kind: hit.kind,
      }
      if (reason) item.reason = reason
      return item
    })

  return { symbol, definitions, truncated }
}
