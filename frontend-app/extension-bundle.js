// Vite-плагин: расширение для WMS (папка ../extension) раздаётся с сайта.
//
// При сборке кладёт в dist:
//   extension/zlp-wms-extension.zip — архив с папкой zlp-wms-extension/ (manifest.json и т.д.)
//   extension/version.json          — { version } из manifest.json
// и подставляет в код сайта __EXT_VERSION__ — им страница «Расширение для WMS»
// показывает актуальную версию, а встроенный в WMS сайт сообщает её расширению
// (уведомление «Доступно обновление»).
//
// В Docker-сборке папка extension копируется рядом с frontend-app (см. Dockerfile).
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'

const ZIP_NAME = 'zlp-wms-extension.zip'
const ZIP_FOLDER = 'zlp-wms-extension'

export function extensionBundle(extDir) {
  const manifestPath = path.join(extDir, 'manifest.json')
  const readVersion = () => {
    try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
  }

  async function buildZip() {
    const zip = new JSZip()
    const folder = zip.folder(ZIP_FOLDER)
    for (const name of fs.readdirSync(extDir)) {
      const p = path.join(extDir, name)
      if (fs.statSync(p).isFile()) folder.file(name, fs.readFileSync(p))
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  }

  return {
    name: 'zlp-extension-bundle',
    config() {
      return { define: { __EXT_VERSION__: JSON.stringify(readVersion()) } }
    },
    async generateBundle() {
      if (!fs.existsSync(manifestPath)) {
        this.warn(`Нет расширения в ${extDir} — архив для скачивания не собран`)
        return
      }
      this.emitFile({ type: 'asset', fileName: `extension/${ZIP_NAME}`, source: await buildZip() })
      this.emitFile({ type: 'asset', fileName: 'extension/version.json', source: JSON.stringify({ version: readVersion() }) })
    },
    // npm run dev — те же адреса, собираются на лету
    configureServer(server) {
      server.middlewares.use(`/extension/${ZIP_NAME}`, async (_req, res) => {
        res.setHeader('Content-Type', 'application/zip')
        res.end(await buildZip())
      })
      server.middlewares.use('/extension/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ version: readVersion() }))
      })
    },
  }
}
