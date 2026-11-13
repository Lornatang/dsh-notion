import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const compiled = (await readFile(join(root, 'lib/client-build/index.js'), 'utf8')).replace(/[\t ]+$/gm, '')
const output = `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${compiled}\nreturn module.exports;\n}});\n`
await writeFile(join(root, 'lib/client.js'), output)
await rm(join(root, 'lib/client-build'), { recursive: true, force: true })
