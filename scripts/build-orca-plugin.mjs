/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const srcDist = join(repoRoot, 'dist')
const pluginDist = join(repoRoot, 'orca-plugin', 'dist')

const required = [
  join(srcDist, 'lib.js'),
  join(srcDist, 'lib.d.ts'),
  join(srcDist, 'web', 'index.html'),
]
for (const file of required) {
  if (!existsSync(file)) {
    console.error(`Missing build artifact: ${file}. Run \`npm run build\` first.`)
    process.exit(1)
  }
}

rmSync(pluginDist, { recursive: true, force: true })
mkdirSync(pluginDist, { recursive: true })
cpSync(join(srcDist, 'lib.js'), join(pluginDist, 'lib.js'))
cpSync(join(srcDist, 'lib.d.ts'), join(pluginDist, 'lib.d.ts'))
cpSync(join(srcDist, 'web'), join(pluginDist, 'web'), { recursive: true })

console.info(`Synced Skepsis bundle into ${pluginDist}`)
