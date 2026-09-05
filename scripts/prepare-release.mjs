import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = process.argv[2]
if (!version) throw new Error('usage: npm run release:prepare -- X.Y.Z[-(alpha|beta|rc).N]')
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/.test(version)) {
  throw new Error(`unsupported release version ${JSON.stringify(version)}`)
}

const manifestPath = resolve(root, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.version = version
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

run('npm', ['install', '--package-lock-only'])
run('npm', ['run', 'verify'])
run('npm', ['pack', '--dry-run'])

console.log(`release ${version} is verified and ready to commit`)

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`)
}
