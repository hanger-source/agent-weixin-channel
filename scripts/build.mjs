import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'src')
const destination = resolve(root, 'dist')
const files = ['cli.js', 'daemon.js', 'database.js', 'paths.js', 'provider.js', 'adapters/codex.js']

await mkdir(destination, { recursive: true })
for (const file of files) {
  await mkdir(dirname(resolve(destination, file)), { recursive: true })
  await copyFile(resolve(source, file), resolve(destination, file))
}
await chmod(resolve(destination, 'cli.js'), 0o755)

console.log(`built ${files.length} files in ${destination}`)
