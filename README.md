# dsh-plugin-hot-reload

标题、简介、图标和浏览器模块都按磁盘现读现发布：改完立即生效，不用重启 DSH。

A DeepSeek Harness bundle. It replaces three cached resolvers with plain filesystem
walks, so a plugin's display metadata and browser module follow the package on disk
instead of a verdict cached for the life of the process:

| Service | Why it is patched |
| --- | --- |
| `pluginPackages.metaOf` | The Host resolves `locale/*.json` and `icon.svg` through the Node ESM resolver. A package whose export was added after its first read stays bare until restart. |
| `pluginManager.listBundles` | The plugin inventory calls the Host reader directly, so it needs the same disk result even when the Host already produced a fallback. |
| `clientModules.resolveMeta` / `locatePkgJson` | Verdicts are cached in `pkgMeta`, `null` included. Moving a linked package makes its browser half disappear. |

Install it into a profile:

```sh
dsh plugin --profile web add <path-to-this-checkout>
```

Editing another plugin's `locale/`, `icon.svg`, or manifest then needs only a page
refresh. Editing this plugin's own `index.js`, or adding a new importable subpath
export, still needs a restart: Node caches modules by URL.

## Test

```powershell
$env:DSH_RUNTIME = '<dsh-runtime>'
$env:DSH_PROFILE_DIR = '<profile-dir>'
node test/live.test.mjs
```

The check compares this reader against the Host reader for every package the profile
depends on, and reproduces the late-locale case.
