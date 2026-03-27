import type { Plugin } from 'vite';

import path from 'path';
import { load } from 'cheerio';
import { existsSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';

// Constants
const HTML_EXTENSION = '.html';
const MANIFEST_LINK_SELECTOR = 'link[rel="manifest"]';

/**
 * Icon type for WebManifest
 */
export type Icon = {
    src: string;
    sizes: string;
    type: string;
};

/**
 * Shortcut type for WebManifest
 */
export type Shortcut = {
    name: string;
    url: string;
    description: string;
    icons: Array<{
        src: string;
        sizes: string;
    }>;
};

/**
 * WebManifest type
 */
export type WebManifest = {
    scope?: string;
    start_url?: string;
    icons?: Icon[];
    screenshots?: Icon[];
    shortcuts?: Shortcut[];
};

/**
 * Plugin configuration options
 */
export type WebManifestPluginOptions = {
    /**
     * HTML entry points to process. Defaults to ['index.html'].
     * Each entry point's manifest will be processed independently.
     */
    entrypoints?: string[];
};

/**
 * Check if file exists
 */
function exists(filePath: string): boolean {
    return existsSync(filePath);
}

/**
 * File cache for avoiding duplicate reads
 */
const fileCache = new Map<string, Buffer>();

/**
 * Path cache for avoiding duplicate path operations
 */
const pathCache = new Map<string, { ext: string; name: string }>();

/**
 * Get file from cache or read from disk
 */
async function getCachedFile(filePath: string): Promise<Buffer> {
    if (!fileCache.has(filePath)) {
        fileCache.set(filePath, await readFile(filePath));
    }
    return fileCache.get(filePath)!;
}

/**
 * Resolve icon path from src
 */
function resolveIconPath(src: string, root: string): string {
    if (src.startsWith('/')) {
        return path.join(root, src.slice(1));
    }
    return path.resolve(root, src);
}

/**
 * Build manifest href respecting base from vite config
 */
function buildManifestHref(base: string, manifestFileName: string): string {
    return `${base}${manifestFileName}`;
}

/**
 * Update an HTML file to reference the root manifest
 */
async function updateHtmlManifestLinks(
    htmlFilePath: string,
    base: string,
    manifestFileName: string
): Promise<void> {
    if (existsSync(htmlFilePath)) {
        try {
            const htmlContent = await readFile(htmlFilePath, 'utf-8');
            const $ = load(htmlContent);
            const manifestLink = $(MANIFEST_LINK_SELECTOR);

            if (manifestLink.length > 0) {
                manifestLink.attr('href', buildManifestHref(base, manifestFileName));
                await writeFile(htmlFilePath, $.html(), 'utf-8');
            }
        } catch (error) {
            console.error(
                `❌ Failed to update HTML: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

/**
 * Process and emit icons in parallel for better performance
 */
async function emitIcons(
    icons: Icon[] | undefined,
    root: string,
    callback: (iconName: string, iconPath: string) => Promise<string>,
    pluginContext: any,
    errorCode: string = 'ICON_NOT_FOUND'
): Promise<void> {
    if (!icons || !Array.isArray(icons)) {
        return;
    }

    await Promise.all(
        icons.map(async (icon) => {
            const iconPath = resolveIconPath(icon.src, root);

            if (exists(iconPath)) {
                // Cache path operations for better performance
                let pathInfo = pathCache.get(iconPath);
                if (!pathInfo) {
                    const iconExt = path.extname(iconPath);
                    const iconName = path.basename(iconPath, iconExt);
                    pathInfo = { ext: iconExt, name: iconName };
                    pathCache.set(iconPath, pathInfo);
                }

                const fileName = await callback(`${pathInfo.name}${pathInfo.ext}`, iconPath);

                // Update the icon path in the manifest
                icon.src = fileName;
            } else {
                pluginContext.error(`Icon file not found: ${iconPath}`, {
                    code: errorCode,
                });
            }
        })
    );
}

/**
 * Process and emit shortcut icons in parallel for better performance
 */
async function emitShortcutIcons(
    shortcuts: Shortcut[] | undefined,
    root: string,
    callback: (iconName: string, iconPath: string) => Promise<string>,
    pluginContext: any
): Promise<void> {
    if (!shortcuts || !Array.isArray(shortcuts)) {
        return;
    }

    // Process shortcut icons individually since they have different structure
    await Promise.all(
        shortcuts.flatMap((shortcut) =>
            shortcut.icons.map(async (icon) => {
                const iconPath = resolveIconPath(icon.src, root);

                if (exists(iconPath)) {
                    // Cache path operations for better performance
                    let pathInfo = pathCache.get(iconPath);
                    if (!pathInfo) {
                        const iconExt = path.extname(iconPath);
                        const iconName = path.basename(iconPath, iconExt);
                        pathInfo = { ext: iconExt, name: iconName };
                        pathCache.set(iconPath, pathInfo);
                    }

                    const fileName = await callback(`${pathInfo.name}${pathInfo.ext}`, iconPath);

                    // Update the icon path in the manifest
                    icon.src = fileName;
                } else {
                    pluginContext.error(`Shortcut icon file not found: ${iconPath}`, {
                        code: 'SHORTCUT_ICON_NOT_FOUND',
                    });
                }
            })
        )
    );
}

/**
 * Vite plugin for transforming webmanifest
 *
 * Features:
 * - Optimizes icons, screenshots and shortcuts by processing them in parallel
 * - Updates manifest paths according to the build configuration
 * - Always emits manifest to the root of the build output
 * - Maintains file hashing for cache busting
 * - Updates HTML links automatically
 *
 * @param options - Plugin configuration options
 * @returns Vite plugin instance
 */
export const webmanifestPlugin = (_options: WebManifestPluginOptions = {}): Plugin => {
    let base: string = './';
    let root: string = process.cwd();

    // Store manifest file names per HTML entry for writeBundle hook
    const storedManifestMap = new Map<string, string>(); // entrypoint -> manifestFileName in assets

    return {
        name: 'vite:webmanifest',
        apply: 'build',
        enforce: 'pre',

        configResolved(config) {
            base = config.base;
            root = config.root;
        },

        async generateBundle(_, bundle) {
            fileCache.clear();
            storedManifestMap.clear();

            const pluginContext = this;
            const entrypoints = _options.entrypoints ?? ['index.html'];

            await Promise.all(
                entrypoints.map(async (entrypoint) => {
                    let manifestPath: string | undefined;
                    const indexPath = path.resolve(root, entrypoint);

                    if (exists(indexPath)) {
                        const indexContent = await readFile(indexPath, 'utf-8');
                        const $ = load(indexContent);
                        const manifestLink = $(MANIFEST_LINK_SELECTOR);

                        if (manifestLink.length > 0) {
                            const href = manifestLink.attr('href');
                            if (href) {
                                if (href.startsWith('/')) {
                                    manifestPath = path.join(root, href.slice(1));
                                } else {
                                    manifestPath = path.resolve(root, href);
                                }
                            }
                        }
                    }

                    if (!manifestPath || !exists(manifestPath)) {
                        pluginContext.error(
                            `WebManifest file not found for ${entrypoint}. Make sure it contains <link rel="manifest" href="...">`
                        );
                        return;
                    }

                    let manifestJson: WebManifest = {};
                    try {
                        const manifestContent = await readFile(manifestPath, 'utf-8');
                        manifestJson = JSON.parse(manifestContent) as WebManifest;
                    } catch (error) {
                        pluginContext.error(
                            `Failed to parse WebManifest file: ${error instanceof Error ? error.message : String(error)}`
                        );
                        return;
                    }

                    manifestJson.scope = base;
                    manifestJson.start_url = base;

                    const emitFileCallback = async (iconName: string, iconPath: string): Promise<string> => {
                        const fileId = pluginContext.emitFile({
                            type: 'asset',
                            name: iconName,
                            source: await getCachedFile(iconPath),
                        });
                        return `./${pluginContext.getFileName(fileId)}`;
                    };

                    await Promise.all([
                        emitIcons(manifestJson.icons, root, emitFileCallback, pluginContext),
                        emitIcons(manifestJson.screenshots, root, emitFileCallback, pluginContext),
                        emitShortcutIcons(manifestJson.shortcuts, root, emitFileCallback, pluginContext),
                    ]);

                    if (manifestJson.screenshots && manifestJson.screenshots.length === 0) {
                        delete manifestJson.screenshots;
                    }
                    if (manifestJson.shortcuts && manifestJson.shortcuts.length === 0) {
                        delete manifestJson.shortcuts;
                    }

                    const manifestExt = path.extname(manifestPath);
                    const manifestName = path.basename(manifestPath, manifestExt);
                    const fileId = pluginContext.emitFile({
                        type: 'asset',
                        name: `${manifestName}${manifestExt}`,
                        source: JSON.stringify(manifestJson, null, 4),
                    });
                    const manifestfileName = pluginContext.getFileName(fileId);

                    storedManifestMap.set(entrypoint, manifestfileName);
                })
            );

            const emittedManifestNames = new Set(storedManifestMap.values());

            for (const fileName in bundle) {
                const fileChunk = bundle[fileName];

                if (
                    fileName.endsWith(HTML_EXTENSION) &&
                    fileChunk.type === 'asset' &&
                    typeof fileChunk.source === 'string'
                ) {
                    const manifestfileName = storedManifestMap.get(fileName);
                    if (manifestfileName) {
                        const $ = load(fileChunk.source);
                        const manifestLink = $(MANIFEST_LINK_SELECTOR);
                        if (manifestLink.length > 0) {
                            manifestLink.attr('href', buildManifestHref(base, manifestfileName));
                            fileChunk.source = $.html();
                        }
                    }
                }

                // Remove original manifest files from bundle
                if (fileName.endsWith('.json') && !emittedManifestNames.has(fileName)) {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                    delete bundle[fileName];
                }
            }

            fileCache.clear();
            pathCache.clear();
        },

        async writeBundle(options) {
            if (storedManifestMap.size === 0) return;

            const outputDir = options.dir || 'dist';

            await Promise.all(
                [...storedManifestMap.entries()].map(async ([entrypoint, assetManifestPath]) => {
                    const assetsManifestAbsPath = path.join(outputDir, assetManifestPath);
                    try {
                        if (!existsSync(assetsManifestAbsPath)) return;

                        const manifestFileName = assetManifestPath.replace(/^assets\//, '');
                        const rootManifestPath = path.join(outputDir, manifestFileName);

                        const manifestContent = await readFile(assetsManifestAbsPath, 'utf-8');
                        await writeFile(rootManifestPath, manifestContent, 'utf-8');
                        await updateHtmlManifestLinks(path.join(outputDir, entrypoint), base, manifestFileName);
                        await unlink(assetsManifestAbsPath);
                    } catch (error) {
                        console.error(
                            `❌ Failed to move manifest: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                })
            );
        },
    };
};
