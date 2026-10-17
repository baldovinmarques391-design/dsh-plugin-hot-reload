/**
 * One check for both halves of the merged plugin.
 *
 *   1. The disk reader must produce exactly the Host reader's metadata for every
 *      package the profile depends on.
 *   2. Metadata added after an unreadable first read must become visible without
 *      a restart, while the Host reader stays stale (the bug being fixed).
 *   3. The service patches must fill only missing entries, keep the original for
 *      specifiers this reader cannot answer, and restore both prototypes.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const RUNTIME = process.env.DSH_RUNTIME
const APP_BOOT = process.argv[2] ?? (RUNTIME === undefined
  ? undefined
  : join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
const PROFILE = process.env.DSH_PROFILE_DIR
if (APP_BOOT === undefined || PROFILE === undefined) {
  console.error('[live] set DSH_RUNTIME and DSH_PROFILE_DIR, or pass the dsh-app-boot entry as argv[2]')
  process.exit(2)
}

const { readPluginMeta } = await import(pathToFileURL(APP_BOOT).href)
const { apply, readLivePluginMeta, locatePackageManifest } = await import('../index.js')

const profileBase = pathToFileURL(join(PROFILE, 'package.json')).href
const dependencies = Object.keys(JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies ?? {})

let failed = 0
const check = (ok, message) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
}

// 1. parity with the Host reader
for (const specifier of dependencies) {
  const host = readPluginMeta(specifier, pathToFileURL(join(PROFILE, 'node_modules', specifier, 'package.json')).href)
  const live = readLivePluginMeta(specifier, profileBase)
  try {
    assert.deepEqual(live, host)
    check(true, `${specifier}: identical to the Host reader`)
  } catch {
    check(false, `${specifier}: differs from the Host reader`)
  }
}

// 2. metadata added after a failed first read
const root = mkdtempSync(join(tmpdir(), 'plugin-hot-reload-'))
try {
  const profileDir = join(root, 'profile')
  const packageDir = join(root, 'late-plugin')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(join(packageDir, 'locale'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"probe-profile"}', 'utf8')
  writeFileSync(join(packageDir, 'index.js'), 'export function apply() {}\n', 'utf8')
  const manifest = (ready) => JSON.stringify({
    name: 'late-plugin',
    version: '1.0.0',
    ...(ready ? { icon: './icon.svg' } : {}),
    exports: { '.': './index.js', ...(ready ? { './package.json': './package.json', './locale/*.json': './locale/*.json' } : {}) },
  }, null, 2)
  writeFileSync(join(packageDir, 'package.json'), manifest(false), 'utf8')
  symlinkSync(packageDir, join(profileDir, 'node_modules', 'late-plugin'), 'junction')
  const base = pathToFileURL(join(profileDir, 'package.json')).href

  assert.equal(readPluginMeta('late-plugin', base), undefined)
  writeFileSync(join(packageDir, 'locale', 'en.json'), '{"meta":{"title":"Late","description":"Added later."}}', 'utf8')
  writeFileSync(join(packageDir, 'locale', 'zh.json'), '{"meta":{"title":"后补的"}}', 'utf8')
  writeFileSync(join(packageDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24"/></svg>', 'utf8')
  writeFileSync(join(packageDir, 'package.json'), manifest(true), 'utf8')

  const live = readLivePluginMeta('late-plugin', base)
  assert.ok(live !== undefined)
  assert.equal(live.title.zh, '后补的')
  assert.ok(live.icon?.startsWith('data:image/svg+xml;base64,'))
  check(true, 'added locale and icon are visible without a restart')
  check(readPluginMeta('late-plugin', base) === undefined, 'Host reader stays stale in the same process (the bug being fixed)')
} finally {
  rmSync(root, { recursive: true, force: true })
}

// 3. service patches
class FakePackages {
  metaOf(specifier) { return { stale: true, specifier } }
}
class FakeManager {
  async listBundles() {
    return [
      { name: 'dsh-ban-strikethrough', enabled: true },
      { name: 'no-such-package-anywhere' },
      // The Host reader fell back to the manifest name/description (its locale
      // resolution was cached before the export existed). The overlay must win.
      { name: 'dsh-ban-strikethrough', meta: { title: 'dsh-ban-strikethrough', description: 'stale fallback' } },
    ]
  }
}
const profileCordis = pathToFileURL(join(PROFILE, 'cordis.yml')).href
const services = { pluginPackages: new FakePackages(), pluginManager: new FakeManager() }
const disposers = []
const ctx = {
  baseUrl: profileCordis,
  logger: { warn: () => {} },
  get: (name) => services[name],
  inject: (names, callback) => callback(ctx),
  effect: (run) => { disposers.push(run()) },
}

apply(ctx)
const live = services.pluginPackages.metaOf('dsh-ban-strikethrough', ctx.baseUrl)
assert.equal(live.title.zh, '禁止删除线')
check(true, 'pluginPackages.metaOf returns live metadata')

assert.deepEqual(services.pluginPackages.metaOf('cordis:include', ctx.baseUrl), { stale: true, specifier: 'cordis:include' })
check(true, 'non-package specifiers fall through to the original')

const bundles = await services.pluginManager.listBundles()
assert.equal(bundles[0].meta.title.zh, '禁止删除线')
assert.equal(bundles[1].meta, undefined)
assert.equal(bundles[2].meta.title.zh, '禁止删除线', 'a defined Host fallback must be replaced by the disk read')
assert.notEqual(bundles[2].meta.description, 'stale fallback')
check(true, 'pluginManager.listBundles overlays the disk metadata, including over a Host fallback')

for (const dispose of disposers) dispose()
assert.equal(Object.hasOwn(services.pluginPackages, 'metaOf'), false)
assert.equal(Object.hasOwn(services.pluginManager, 'listBundles'), false)
check(true, 'disposal restores both prototypes')

assert.equal(locatePackageManifest('dsh-ban-strikethrough', ctx.baseUrl)?.packageName, 'dsh-ban-strikethrough')
assert.equal(locatePackageManifest('dsh-ban-strikethrough/client', ctx.baseUrl), undefined)
check(true, 'browser-module locator resolves packages and rejects subpaths')

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
