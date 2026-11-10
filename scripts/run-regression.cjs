// Explicit discovery avoids silently missing root, tests/ or legacy test-*.cjs files.
const { readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const root = resolve(__dirname, '..')
const files = ['', 'scripts', 'tests'].flatMap(dir => readdirSync(join(root, dir))
  .filter(name => /(?:\.test\.[cm]js$|^test-.*\.cjs$)/.test(name))
  .map(name => join(dir, name))).sort()
console.log(`Regression discovery: ${files.length} test files`)
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
if (result.error) console.error(result.error)
process.exitCode = result.status ?? 1
