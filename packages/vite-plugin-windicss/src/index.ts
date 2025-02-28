import { resolve } from 'path'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import _debug, { log } from 'debug'
import { UserOptions, WindiPluginUtils, createUtils, WindiPluginUtilsOptions } from '@windicss/plugin-utils'
import { createVirtualModuleLoader, MODULE_ID_VIRTUAL_PREFIX } from '../../shared/virtual-module'
import { createDevtoolsPlugin } from './devtools'
import { NAME } from './constants'
import { getChangedModuleNames, getCssModules, invalidateCssModules, reloadChangedCssModules } from './modules'

const debug = {
  hmr: _debug(`${NAME}:hmr`),
  css: _debug(`${NAME}:transform:css`),
  group: _debug(`${NAME}:transform:group`),
  memory: _debug(`${NAME}:memory`),
}

function VitePluginWindicss(userOptions: UserOptions = {}, utilsOptions: WindiPluginUtilsOptions = {}): Plugin[] {
  let utils: WindiPluginUtils
  let viteConfig: ResolvedConfig
  let server: ViteDevServer | undefined

  const plugins: Plugin[] = []

  // Utilities grouping transform
  if (userOptions.transformGroups !== false) {
    plugins.push({
      name: `${NAME}:groups`,
      async transform(code, id) {
        await utils.ensureInit()
        if (!utils.isDetectTarget(id))
          return
        debug.group(id)
        if (viteConfig.build.sourcemap)
          return utils.transformGroupsWithSourcemap(code)
        else
          return utils.transformGroups(code)
      },
    })
  }

  // exposing api
  plugins.push({
    name: NAME,
    get api() {
      return utils
    },
  })

  // CSS Entry via virtual module
  plugins.push({
    name: `${NAME}:entry`,
    enforce: 'post',

    configureServer(_server) {
      server = _server
    },

    async configResolved(_config) {
      viteConfig = _config
      utils = createUtils(userOptions, {
        name: NAME,
        root: _config.root,
        onConfigurationError(e) {
          if (_config.command === 'build') {
            throw e
          }
          else {
            console.error(`[${NAME}] Error on loading configurations`)
            console.error(e)
          }
        },
        ...utilsOptions,
      })
      await utils.init()
    },

    ...createVirtualModuleLoader({ get utils() { return utils } }),
  })

  // HMR
  plugins.push({
    name: `${NAME}:hmr`,
    apply: 'serve',
    enforce: 'post',

    async configureServer(_server) {
      server = _server

      await utils.ensureInit()
      if (utils.configFilePath)
        server.watcher.add(utils.configFilePath)

      // NOTE: Track changes to the files so that they are re-scanned as needed.
      // Added files are only detected if the user explicitly enables globbing.
      const supportsGlobs = server.config.server.watch?.disableGlobbing === false
      server.watcher.add(supportsGlobs ? utils.globs : await utils.getFiles())
    },

    async handleHotUpdate({ server, file, read, modules }) {
      // resolve normalized file path to system path
      if (resolve(file) === utils.configFilePath) {
        debug.hmr(`config file changed: ${file}`)
        await utils.init()
        setTimeout(() => {
          log('configure file changed, reloading')
          server.ws.send({ type: 'full-reload' })
        }, 0)
        return getCssModules(server)
      }

      if (!utils.isDetectTarget(file))
        return

      const changed = await utils.extractFile(await read(), file, true)
      if (!changed)
        return

      const cssModules = getCssModules(server, getChangedModuleNames(utils))

      debug.hmr(`refreshed by ${file}`)
      invalidateCssModules(server, cssModules)

      if (file.endsWith('.html'))
        return undefined

      return [...cssModules, ...modules].filter(Boolean)
    },
  })

  const { transformCSS: transformCSSOptions = true } = userOptions

  const transformCSS = (code: string, id: string) => utils.transformCSS(code, id, {
    onLayerUpdated() {
      if (server)
        reloadChangedCssModules(server, utils)
    },
  })

  // CSS transform
  if (transformCSSOptions === true) {
    plugins.push({
      name: `${NAME}:css`,
      async transform(code, id) {
        await utils.ensureInit()
        if (!utils.isCssTransformTarget(id) || id.startsWith(MODULE_ID_VIRTUAL_PREFIX))
          return
        debug.css(id)
        return {
          code: transformCSS(code, id),
          map: { mappings: '' },
        }
      },
    })
  }
  else if (typeof transformCSSOptions === 'string') {
    plugins.push({
      name: `${NAME}:css`,
      enforce: transformCSSOptions,
      transform(code, id) {
        if (!utils.isCssTransformTarget(id) || id.startsWith(MODULE_ID_VIRTUAL_PREFIX))
          return
        debug.css(id, transformCSSOptions)
        return {
          code: transformCSS(code, id),
          map: { mappings: '' },
        }
      },
    })
  }

  plugins.push({
    name: `${NAME}:css:svelte`,
    // @ts-expect-error for svelte preprocess
    sveltePreprocess: {
      style({ content, id }: { content: string; id: string}) {
        return {
          code: transformCSS(content, id),
        }
      },
    },
  })

  plugins.push(...createDevtoolsPlugin({ get utils() { return utils } }))

  return plugins
}

export * from '@windicss/plugin-utils'
export default VitePluginWindicss
