/**
 * electron-builder configuration, driven by the brand.
 *
 * The product name, the bundle identifier and the icons are the installer's
 * half of an identity whose other half — the window name, the data directory,
 * the update source — the app reads at runtime from the same file. Keeping
 * both halves on one document is what makes a rebrand an edit rather than a
 * search: change assets/brand.json, run the same dist script, get an
 * installer under the new name that updates from the new repository and keeps
 * its data somewhere the original will not collide with.
 *
 * This lives in a file rather than package.json's `build` field because a
 * field cannot read anything.
 */
const { readFileSync } = require('node:fs')

const brand = JSON.parse(readFileSync(require('node:path').join(__dirname, 'assets/brand.json'), 'utf8'))

module.exports = {
  appId: brand.appId,
  productName: brand.name,
    "directories": {
      "output": "dist"
    },
    "afterPack": "scripts/adhoc-sign.cjs",
    "files": [
      "src/**",
      "assets/**",
      "package.json"
    ],
    "extraResources": [
      {
        "from": "seed.tar",
        "to": "runtime-seed.tar"
      },
      {
        "from": "node-runtime.tgz",
        "to": "node-runtime.tgz"
      },
      {
        "from": "node-runtime.version",
        "to": "node-runtime.version"
      }
    ],
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "perMachine": false
    },
  win: {
    icon: brand.icons?.win ?? 'assets/icon-1024.png',
    "target": [
      "nsis",
      "dir"
    ],
  },
  mac: {
    icon: brand.icons?.mac ?? 'assets/icon.icns',
    "identity": null,
    "artifactName": "${productName}-${version}-${arch}.${ext}",
    "category": "public.app-category.developer-tools",
    "extendInfo": {
      "CFBundleDocumentTypes": [
        {
          "CFBundleTypeName": "Any file",
          "CFBundleTypeRole": "Viewer",
          "LSHandlerRank": "Alternate",
          "LSItemContentTypes": [
            "public.item"
          ]
        }
      ],
      "NSDocumentsFolderUsageDescription": "需要访问此位置,以便安装和加载存放在这里的 dsh 插件。 / Needed to install and load dsh plugins kept here.",
      "NSDownloadsFolderUsageDescription": "需要访问此位置,以便安装和加载存放在这里的 dsh 插件。 / Needed to install and load dsh plugins kept here.",
      "NSDesktopFolderUsageDescription": "需要访问此位置,以便安装和加载存放在这里的 dsh 插件。 / Needed to install and load dsh plugins kept here.",
      "NSRemovableVolumesUsageDescription": "需要访问此位置,以便安装和加载存放在这里的 dsh 插件。 / Needed to install and load dsh plugins kept here."
    },
  },
}
