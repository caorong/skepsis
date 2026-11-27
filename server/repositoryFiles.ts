/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify, TextDecoder } from 'node:util'
import { HTTPException } from 'hono/http-exception'
import type { RepositoryFile } from '../shared/types.ts'

const exec = promisify(execFile)
const MAX_FILE_BYTES = 1024 * 1024
const MAX_OUTPUT = 32 * 1024 * 1024

function reviewPath(file: string): boolean {
  return (
    !!file &&
    !isAbsolute(file) &&
    !file.includes('\0') &&
    !file.includes('\\') &&
    file
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !['.git', '.jj'].includes(part.toLowerCase()),
      )
  )
}

async function gitFiles(root: string, file?: string): Promise<string[]> {
  const { stdout } = await exec(
    'git',
    [
      '--literal-pathspecs',
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      ...(file ? ['--', file] : []),
    ],
    { cwd: root, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
  )
  return stdout.split('\0')
}

export function createRepositoryFiles(root: string, vcs: 'git' | 'jj') {
  let useGit: Promise<boolean> | undefined
  const list = async (file?: string): Promise<string[]> => {
    useGit ??=
      vcs === 'git'
        ? Promise.resolve(true)
        : exec('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' })
            .then(
              async ({ stdout }) =>
                (await realpath(stdout.trim())) === (await realpath(root)),
            )
            .catch(() => false)
    if (await useGit) return gitFiles(root, file)
    const { stdout } = await exec('jj', ['file', 'list', '-r', '@'], {
      cwd: root,
      maxBuffer: MAX_OUTPUT,
      encoding: 'utf8',
    })
    return stdout.split('\n')
  }
  const paths = async () => [...new Set((await list()).filter(reviewPath))]

  const read = async (file: string): Promise<RepositoryFile> => {
    if (!reviewPath(file) || !(await list(file)).includes(file))
      throw new HTTPException(404, { message: 'File is not in this checkout.' })
    const base = await realpath(root)
    const abs = join(base, file)
    const actual = await realpath(abs).catch(() => null)
    if (!actual)
      throw new HTTPException(404, { message: 'File is not present in the working tree.' })
    if (actual !== abs)
      throw new HTTPException(415, { message: 'Symlinks cannot be opened in Files view.' })

    const fd = await open(
      abs,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => {
      throw new HTTPException(404, { message: 'File could not be opened.' })
    })
    try {
      const stat = await fd.stat()
      if (!stat.isFile())
        throw new HTTPException(415, { message: 'Only regular text files can be opened.' })
      if (stat.size > MAX_FILE_BYTES)
        throw new HTTPException(413, { message: 'File is larger than 1 MiB.' })
      // Read a bounded snapshot even if the file grows after stat().
      const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1)
      let offset = 0
      while (offset < buffer.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The next read depends on the preceding byte count.
        const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > MAX_FILE_BYTES)
        throw new HTTPException(413, { message: 'File is larger than 1 MiB.' })
      const bytes = buffer.subarray(0, offset)
      let contents: string
      try {
        if (bytes.includes(0)) throw new TypeError('binary')
        contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (cause) {
        throw new HTTPException(415, {
          message: 'Only UTF-8 text files can be opened.',
          cause,
        })
      }
      return {
        path: file,
        contents,
        revision: createHash('sha256').update(bytes).digest('hex'),
      }
    } finally {
      await fd.close()
    }
  }

  return { paths, read, root }
}

/** Real 1-based file line numbers, with no synthetic line after a final newline. */
export function sourceLines(contents: string): string[] {
  if (contents === '') return []
  const lines = contents.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line) => line.replace(/\r$/, ''))
}
