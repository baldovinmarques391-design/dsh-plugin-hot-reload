/**
 * Plugin hot reload 鈥?display metadata and browser modules, read from disk.
 *
 * Editing this file only takes effect after the Loader re-imports it: Node caches
 * a module by URL for the process lifetime, so reinstalling the bundle does not
 * reload this code. The profile patch's `hmr.root` entry is what makes a save
 * here reload the row.
 *
 * Two caches in the Host keep an edited or moved plugin invisible until DSH
 * restarts, and both come from the same habit: resolving a package once, with
 * the runtime ESM resolver, and keeping the verdict.
 *
 *   1. Display metadata (`pluginPackages.metaOf` 鈫?`readPluginMeta`, and the
 *      plugin manager's own `listBundles`) locates a plugin's `package.json` and
 *      `locale/*.json` through `ModuleLoader.resolveSync`. Node's module map
 *      caches failed resolutions for the process, so a package whose metadata
 *      was unreadable once 鈥?no `./locale/*.json` export yet, no icon yet 鈥? *      stays bare until restart.
 *   2. Browser modules (`clientModules`) cache every per-specifier verdict in
 *      `pkgMeta`, `null` included, and resolve packages the same cached way. Move
 *      a linked plugin directory and its browser half silently disappears,
 *      because the cached path now points at a directory that no longer exists.
 *
 * This plugin replaces both resolvers with ordinary `node_modules` walks, drops
 * the cached verdicts, and rescans on apply, so an edit, a move, or a late
 * `dsh.client`/`icon.svg` is picked up by the open page. Native implementations
 * still handle every request this reader cannot answer.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Locale filenames must be language ids. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
/** Same icon ceiling the Host applies. */
const MAX_ICON_BYTES = 256 * 1024
/** Accepted icon file types, mapped to the media type embedded in the data URL. */
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])
/** Marks a service instance already wrapped by this plugin. */
const PATCHED_PACKAGES = Symbol.for('dsh-plugin-hot-reload.packages')
const PATCHED_MANAGER = Symbol.for('dsh-plugin-hot-reload.manager')
const PATCHED_MODULES = Symbol.for('dsh-plugin-hot-reload.modules')

/**
 * The package name a specifier belongs to, or undefined for anything that is
 * not a package request (relative paths, URLs, builtins).
 * @param {string} request - module specifier.
 * @returns {string | undefined} bare package name.
 */
function barePackageName(request) {
  if (typeof request !== 'string' || request.length === 0) return undefined
  if (['.', '/', '\\', '#'].includes(request[0])) return undefined
  if (request.includes(':')) return undefined
  const first = request.indexOf('/')
  if (request[0] !== '@') return first < 0 ? request : request.slice(0, first)
  if (first < 0) return undefined
  const second = request.indexOf('/', first + 1)
  return second < 0 ? request : request.slice(0, second)
}

/**
 * The package name of an exact package specifier; subpaths are rejected.
 * @param {string} request - module specifier.
 * @returns {string | undefined} package name.
 */
function exactPackageName(request) {
  const name = barePackageName(request)
  return name === undefined || name !== request ? undefined : name
}

/**
 * Locate a package directory with Node's ordinary lookup order, without the
 * caching ESM resolver.
 * @param {string} name - bare package name.
 * @param {string} parentURL - owning Loader tree's resolution base.
 * @returns {string | undefined} package directory containing a package.json.
 */
function packageDirectory(name, parentURL) {
  let searchPaths
  try {
    searchPaths = createRequire(parentURL).resolve.paths(name)
  } catch {
    return undefined
  }
  for (const searchPath of searchPaths ?? []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Trim a display field: any non-empty string, otherwise undefined.
 * @param {unknown} value - candidate value.
 * @returns {string | undefined} the text.
 */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read every locale file beside the package's English one. English is the gate,
 * as in the Host reader; a half-written file is skipped rather than blanking
 * the whole package.
 * @param {string} dir - package directory.
 * @returns {Map<string, { title?: string, description?: string }>} dictionaries by language id.
 */
function readDictionaries(dir) {
  const localeDir = join(dir, 'locale')
  if (!existsSync(join(localeDir, 'en.json'))) return new Map()
  let entries
  try {
    entries = readdirSync(localeDir, { withFileTypes: true })
  } catch {
    return new Map()
  }
  const dictionaries = new Map()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const language = entry.name.slice(0, -5)
    if (!LANGUAGE_ID.test(language)) continue
    const id = language.toLowerCase()
    if (dictionaries.has(id)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(localeDir, entry.name), 'utf8'))
    } catch {
      continue
    }
    const meta = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed.meta : undefined
    const fields = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta : {}
    dictionaries.set(id, { title: textOf(fields.title), description: textOf(fields.description) })
  }
  return dictionaries
}

/**
 * Merge dictionaries into the Host's localized-text shape.
 * @param {'title' | 'description'} field - field to read.
 * @param {Map<string, { title?: string, description?: string }>} dictionaries - per-language fields.
 * @param {string | undefined} fallback - English fallback.
 * @param {string} finalFallback - value used when the fallback is absent.
 * @returns {string | { en: string } | undefined} localized text.
 */
function localizedText(field, dictionaries, fallback, finalFallback) {
  const entries = [...dictionaries].flatMap(([language, fields]) => {
    const value = fields[field]
    return value === undefined ? [] : [[language, value]]
  })
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}

/**
 * Read the manifest icon as a data URL, under the Host's rules.
 * @param {unknown} value - manifest `icon` field.
 * @param {string} manifestPath - manifest file the path is relative to.
 * @returns {string | undefined} data URL.
 */
function iconOf(value, manifestPath) {
  const icon = textOf(value)
  if (icon === undefined) return undefined
  if (isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) {
    throw new Error(`${manifestPath}: icon must be a relative file path`)
  }
  const mediaType = ICON_MEDIA_TYPES.get(extname(icon).toLowerCase())
  if (mediaType === undefined) throw new Error(`${manifestPath}: icon must be SVG, PNG, JPEG, or WebP`)
  const directory = realpathSync(dirname(manifestPath))
  const file = realpathSync(resolve(directory, icon))
  const local = relative(directory, file)
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`${manifestPath}: icon must remain inside its manifest directory`)
  }
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`${manifestPath}: icon must be a regular file`)
  if (stat.size > MAX_ICON_BYTES) throw new Error(`${manifestPath}: icon exceeds 256 KiB`)
  const bytes = readFileSync(file)
  if (bytes.length > MAX_ICON_BYTES) throw new Error(`${manifestPath}: icon exceeds 256 KiB`)
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

/**
 * Read one package's display metadata straight from disk.
 * @param {string} specifier - configured module name, including any subpath.
 * @param {string | undefined} parentURL - owning Loader tree's resolution base.
 * @returns {{ title?: unknown, description?: unknown, icon?: string, error?: string } | undefined} display metadata.
 */
export function readLivePluginMeta(specifier, parentURL) {
  if (typeof parentURL !== 'string' || parentURL === '') return undefined
  const name = barePackageName(specifier)
  if (name === undefined) return undefined
  const dir = packageDirectory(name, parentURL)
  if (dir === undefined) return undefined
  const manifestPath = join(dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
  const dictionaries = readDictionaries(dir)
  const title = localizedText('title', dictionaries, textOf(manifest?.name), specifier)
  const description = localizedText('description', dictionaries, textOf(manifest?.description), '')
  const text = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
  let icon
  try {
    icon = iconOf(manifest?.icon, manifestPath)
  } catch (error) {
    return { ...text, error: `Plugin metadata for ${specifier}: ${String(error)}` }
  }
  if (title === undefined && description === undefined && icon === undefined) return undefined
  return { ...text, ...(icon === undefined ? {} : { icon }) }
}

/**
 * Locate a package manifest for the browser-module table, without the ESM resolver.
 * @param {string} loaderName - the Loader row's module specifier.
 * @param {string} baseUrl - resolution base of the tree that owns the row.
 * @returns {{ path: string, packageName: string } | undefined} manifest location.
 */
export function locatePackageManifest(loaderName, baseUrl) {
  if (typeof loaderName !== 'string' || typeof baseUrl !== 'string') return undefined
  if (loaderName.startsWith('cordis:')) return undefined
  if (loaderName.startsWith('.') || loaderName.startsWith('file:') || isAbsolute(loaderName)) return undefined
  const name = exactPackageName(loaderName)
  if (name === undefined) return undefined
  const dir = packageDirectory(name, baseUrl)
  if (dir === undefined) return undefined
  return { path: join(dir, 'package.json'), packageName: name }
}

/**
 * Resolution bases a bundle name can be looked up with: the manager's own
 * profile first, then the Loader tree base.
 * @param {{ profile?: { dir?: string } } | undefined} manager - plugin manager service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {string[]} candidate bases, most specific first.
 */
function lookupBases(manager, ctx) {
  const bases = []
  const dir = manager?.profile?.dir
  if (typeof dir === 'string' && dir !== '') bases.push(pathToFileURL(join(dir, 'package.json')).href)
  if (typeof ctx.baseUrl === 'string' && ctx.baseUrl !== '') bases.push(ctx.baseUrl)
  return bases
}

/**
 * Fill in metadata the Host reader cannot resolve for a bundle name yet.
 * @param {string} name - bundle package name.
 * @param {readonly string[]} bases - candidate resolution bases.
 * @returns {{ title?: unknown, description?: unknown, icon?: string, error?: string } | undefined} metadata.
 */
function metaFor(name, bases) {
  for (const base of bases) {
    const live = readLivePluginMeta(name, base)
    if (live !== undefined) return live
  }
  return undefined
}

/**
 * Plugin inventory: replace `metaOf` with the disk reader.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function patchInventory(ctx) {
  ctx.inject(['pluginPackages'], (ctx) => {
    const packages = ctx.get('pluginPackages')
    if (packages === undefined || packages === null || packages[PATCHED_PACKAGES] === true) return
    const original = packages.metaOf
    if (typeof original !== 'function') return
    const patched = function (specifier, parentURL) {
      const live = readLivePluginMeta(specifier, parentURL)
      return live === undefined ? original.call(this, specifier, parentURL) : live
    }
    packages[PATCHED_PACKAGES] = true
    packages.metaOf = patched
    ctx.effect(() => () => {
      if (packages.metaOf !== patched) return
      delete packages.metaOf
      delete packages[PATCHED_PACKAGES]
    }, 'plugin-hot-reload: restore pluginPackages.metaOf')
  })
}

/**
 * Bundle page: replace the metadata the manager produced with the disk read.
 *
 * The manager resolves a bundle's `package.json` and `locale/*.json` through the
 * runtime ESM resolver, which caches package exports for the process. A plugin
 * whose `./locale/*.json` export was added *after* it was imported therefore
 * falls back to its manifest name and description for the rest of the process 鈥? * the metadata is defined, so it is not a "missing" entry to fill in. The reader
 * here goes straight to the filesystem, so it is used whenever it answers at
 * all; the Host's own result is kept only for bundles this reader cannot find.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function patchBundleListing(ctx) {
  ctx.inject(['pluginManager'], (ctx) => {
    const manager = ctx.get('pluginManager')
    if (manager === undefined || manager === null || manager[PATCHED_MANAGER] === true) return
    const original = manager.listBundles
    if (typeof original !== 'function') return
    const patched = async function (...args) {
      const bundles = await original.apply(this, args)
      if (!Array.isArray(bundles)) return bundles
      const bases = lookupBases(manager, ctx)
      return bundles.map((bundle) => {
        if (bundle === null || typeof bundle !== 'object') return bundle
        const meta = metaFor(bundle.name, bases)
        return meta === undefined ? bundle : { ...bundle, meta }
      })
    }
    manager[PATCHED_MANAGER] = true
    manager.listBundles = patched
    ctx.effect(() => () => {
      if (manager.listBundles !== patched) return
      delete manager.listBundles
      delete manager[PATCHED_MANAGER]
    }, 'plugin-hot-reload: restore pluginManager.listBundles')
  })
}

/**
 * Browser modules: locate packages on disk, stop caching verdicts, rescan.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function patchClientModules(ctx) {
  ctx.inject(['clientModules'], (ctx) => {
    const registry = ctx.get('clientModules')
    if (registry === undefined || registry === null || registry[PATCHED_MODULES] === true) return
    const loader = registry.ctx?.loader ?? ctx.get('loader')
    if (loader === undefined) return

    const userLocate = registry.locatePkgJson
    if (typeof userLocate === 'function') {
      registry.locatePkgJson = function locatePkgJson(loaderName, baseUrl) {
        const live = locatePackageManifest(loaderName, baseUrl)
        return live === undefined ? userLocate.call(this, loaderName, baseUrl) : live
      }
    }

    const verdict = registry.resolveMeta
    if (typeof verdict === 'function') {
      registry.resolveMeta = function resolveMeta(loaderName, baseUrl) {
        try {
          this.pkgMeta?.delete?.(this.sourceKey(loaderName, baseUrl))
        } catch {
          // A registry without that cache simply resolves normally.
        }
        return verdict.call(this, loaderName, baseUrl)
      }
    }

    registry[PATCHED_MODULES] = true
    ctx.effect(() => () => {
      delete registry.locatePkgJson
      delete registry.resolveMeta
      delete registry[PATCHED_MODULES]
    }, 'plugin-hot-reload: restore clientModules resolution')

    try {
      registry.pkgMeta?.clear?.()
      if (registry.dirty instanceof Set) {
        for (const entry of loader.entries()) {
          if (entry.options.group !== undefined) continue
          registry.dirty.add(entry.options.name)
        }
      }
      if (typeof registry.flush === 'function') registry.flush((error) => ctx.logger?.warn?.(String(error)))
    } catch (error) {
      ctx.logger?.warn?.(String(error))
    }
  })
}

/**
 * Install every live path.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  patchInventory(ctx)
  patchBundleListing(ctx)
  patchClientModules(ctx)
}
