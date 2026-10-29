import { buildError, catchError, isFunction, isOutputTargetDocs, isString, relative } from '@utils';
import { join, normalizePath } from '@utils';
import sourceMapMerge from 'merge-source-map';
import { basename, dirname, extname, isAbsolute } from 'path';
import postcss, { PluginCreator } from 'postcss';
import postcssImport from 'postcss-import';

import type * as d from '../../declarations';
import { parseStyleDocs } from '../docs/style-docs';
import { resolveModuleIdAsync } from '../sys/resolve/resolve-module-async';
import { getModuleId } from '../sys/resolve/resolve-utils';

interface ImportPluginOptions {
  compilerCtx: d.CompilerCtx;
  config: d.Config;
}

export const importPlugin = (opts: ImportPluginOptions) => {
  const getTargetPath = async (id: string, basedir: string) => {
    if (id.startsWith('~')) {
      const module = getModuleId(id);

      const resolved = await resolveModuleIdAsync(opts.config.sys, opts.compilerCtx.fs, {
        moduleId: module.moduleId,
        containingFile: id,
        exts: [],
        packageFilter: (pkg) => {
          if (module.filePath !== '') {
            pkg.main = module.filePath;
          }
          return pkg;
        },
      });

      return resolved.resolveId;
    } else if (isAbsolute(id)) {
      return normalizePath(id);
    } else {
      return normalizePath(join(basedir, id));
    }
  };

  return postcssImport({
    load: async (filename: string) => {
      return await opts.compilerCtx.fs.readFile(filename);
    },
    resolve: async (id, basedir) => {
      const targetPath = await getTargetPath(id, basedir);

      const ext = extname(targetPath).toLowerCase();

      if (ext === '.scss') {
        const exists = await opts.compilerCtx.fs.access(targetPath);
        if (exists) {
          return targetPath;
        }

        const base = `_${basename(targetPath)}`;
        const altPath = normalizePath(join(dirname(targetPath), base));

        const altExists = await opts.compilerCtx.fs.access(altPath);
        if (altExists) {
          return altPath;
        }
      }

      return targetPath;
    },
  });
};

interface DocsPluginOptions {
  styleDocs?: d.StyleDoc[];
}

export const styleDocsPlugin: PluginCreator<DocsPluginOptions> = (opts) => {
  return {
    postcssPlugin: 'stencil-extract-style-docs',
    Once(root) {
      if (opts.styleDocs != null) {
        parseStyleDocs(opts.styleDocs, root.toString());
      }
    },
  };
};
styleDocsPlugin.postcss = true;

interface ParseCSSReturn {
  imports: string[];
  styleText: string;
  map?: d.SourceMap;
}
export const parseCssImports = async (
  config: d.ValidatedConfig,
  compilerCtx: d.CompilerCtx,
  buildCtx: d.BuildCtx,
  srcFilePath: string,
  resolvedFilePath: string,
  styleText: string,
  styleDocs?: d.StyleDoc[],
  prevMap?: d.SourceMap,
): Promise<ParseCSSReturn> => {
  try {
    const result = await postcss([importPlugin({ compilerCtx, config }), styleDocsPlugin({ styleDocs })]).process(
      styleText,
      {
        from: resolvedFilePath,
        to: resolvedFilePath,
        map: {
          inline: false,
          annotation: false,
          prev: prevMap,
          sourcesContent: true,
        },
      },
    );

    const allCssImports = result.messages.filter((msg) => msg.type === 'dependency').map((msg) => msg.file);

    return {
      imports: allCssImports,
      styleText: result.css,
      map: result.map ? (result.map.toJSON() as unknown as d.SourceMap) : undefined,
    };
  } catch (error) {
    const err = buildError(buildCtx.diagnostics);
    err.messageText = `Unable to process CSS imports: ${(error as Error).message || error}`;
    err.absFilePath = srcFilePath;

    return {
      imports: [],
      styleText: styleText,
    };
  }
};

export const runPluginResolveId = async (pluginCtx: d.PluginCtx, importee: string) => {
  for (const plugin of pluginCtx.config?.plugins ?? []) {
    if (isFunction(plugin.resolveId)) {
      try {
        const results = plugin.resolveId(importee, null, pluginCtx);

        if (results != null) {
          if (isFunction((results as any).then)) {
            const promiseResults = await results;
            if (promiseResults != null) {
              return promiseResults as string;
            }
          } else if (isString(results)) {
            return results;
          }
        }
      } catch (e: any) {
        catchError(pluginCtx.diagnostics, e);
      }
    }
  }

  // default resolvedId
  return importee;
};

export const runPluginLoad = async (pluginCtx: d.PluginCtx, id: string) => {
  for (const plugin of pluginCtx.config?.plugins ?? []) {
    if (isFunction(plugin.load)) {
      try {
        const results = plugin.load(id, pluginCtx);

        if (results != null) {
          if (isFunction((results as any).then)) {
            const promiseResults = await results;
            if (promiseResults != null) {
              return promiseResults as string;
            }
          } else if (isString(results)) {
            return results;
          }
        }
      } catch (e: any) {
        catchError(pluginCtx.diagnostics, e);
      }
    }
  }

  // default load()
  return pluginCtx.fs.readFile(id);
};

/**
 * returns a subset of the baseline array of strings
 * @param baseline baseline of files
 * @param superset files that were added by a transform
 * @returns files that were added by a transform but haven't been part of the baseline
 */
const getDependencySubset = (baseline: string[] | undefined, superset: string[] = []) => {
  if (!Array.isArray(baseline)) {
    return [];
  }

  return baseline.filter((f) => !superset.includes(f));
};

export const runPluginTransforms = async (
  config: d.ValidatedConfig,
  compilerCtx: d.CompilerCtx,
  buildCtx: d.BuildCtx,
  id: string,
  cmp?: d.ComponentCompilerMeta,
): Promise<d.PluginTransformResults | null> => {
  const pluginCtx: d.PluginCtx = {
    config: config,
    sys: config.sys,
    fs: compilerCtx.fs,
    cache: compilerCtx.cache,
    diagnostics: [],
  };

  const resolvedId = await runPluginResolveId(pluginCtx, id);
  const sourceText = await runPluginLoad(pluginCtx, resolvedId);
  if (!isString(sourceText)) {
    const diagnostic = buildError(buildCtx.diagnostics);
    diagnostic.header = `Unable to find "${basename(id)}"`;
    diagnostic.messageText = `The file "${relative(config.rootDir, id)}" was unable to load.`;
    return null;
  }

  const transformResults = {
    code: sourceText,
    id: id,
    map: undefined as d.SourceMap | undefined,
    dependencies: [] as string[],
  } satisfies d.PluginTransformResults;

  const isRawCssFile = transformResults.id.toLowerCase().endsWith('.css');
  const shouldParseCssDocs = cmp != null && config.outputTargets.some(isOutputTargetDocs);

  if (isRawCssFile) {
    // concat all css @imports into one file
    // when the entry file is a .css file (not .scss)
    // do this BEFORE transformations on css files
    let cssParseResults;
    if (shouldParseCssDocs && cmp != null) {
      cmp.styleDocs = cmp.styleDocs || [];
      cssParseResults = await parseCssImports(
        config,
        compilerCtx,
        buildCtx,
        id,
        id,
        transformResults.code,
        cmp.styleDocs,
      );
    } else {
      cssParseResults = await parseCssImports(config, compilerCtx, buildCtx, id, id, transformResults.code);
    }
    transformResults.code = cssParseResults.styleText;
    transformResults.dependencies = cssParseResults.imports;
    transformResults.map = cssParseResults.map;
  }

  for (const plugin of pluginCtx.config?.plugins ?? []) {
    if (isFunction(plugin.transform)) {
      try {
        let pluginTransformResults: d.PluginTransformResults | string;
        const results = plugin.transform(transformResults.code, transformResults.id, pluginCtx);

        if (results != null) {
          if (isFunction((results as any).then)) {
            pluginTransformResults = await results;
          } else {
            pluginTransformResults = results as d.PluginTransformResults;
          }

          if (pluginTransformResults != null) {
            if (isString(pluginTransformResults)) {
              transformResults.code = pluginTransformResults;
            } else {
              if (isString(pluginTransformResults.code)) {
                transformResults.code = pluginTransformResults.code;
              }
              if (isString(pluginTransformResults.id)) {
                transformResults.id = pluginTransformResults.id;
              }
              if (pluginTransformResults.map != null) {
                transformResults.map = mergePluginSourceMaps(transformResults.map, pluginTransformResults.map);
              }

              /**
               * add dependencies from plugin transform results, e.g. transformed sass files
               */
              transformResults.dependencies.push(
                ...getDependencySubset(pluginTransformResults.dependencies, transformResults.dependencies),
              );
            }
          }
        }
      } catch (e: any) {
        catchError(buildCtx.diagnostics, e);
      }
    }
  }

  buildCtx.diagnostics.push(...pluginCtx.diagnostics);

  if (!isRawCssFile) {
    let cssParseResults;
    // sass precompiler just ran and converted @import "my.css" into @import url("my.css")
    // because of the ".css" extension. Sass did NOT concat the ".css" files into the output
    // but only updated it to use url() instead. Let's go ahead and concat the url() css
    // files into one file like we did for raw .css files.
    // do this AFTER transformations on non-css files
    if (shouldParseCssDocs && cmp != null) {
      cmp.styleDocs = cmp.styleDocs || [];
      cssParseResults = await parseCssImports(
        config,
        compilerCtx,
        buildCtx,
        id,
        transformResults.id,
        transformResults.code,
        cmp.styleDocs,
        transformResults.map,
      );
    } else {
      cssParseResults = await parseCssImports(
        config,
        compilerCtx,
        buildCtx,
        id,
        transformResults.id,
        transformResults.code,
        null,
        transformResults.map,
      );
    }

    transformResults.map = cssParseResults.map;
    transformResults.code = cssParseResults.styleText;
    transformResults.dependencies.push(...getDependencySubset(cssParseResults.imports, transformResults.dependencies));
  }

  return transformResults;
};

export const runPluginTransformsEsmImports = async (
  config: d.ValidatedConfig,
  compilerCtx: d.CompilerCtx,
  buildCtx: d.BuildCtx,
  code: string,
  id: string,
) => {
  const pluginCtx: d.PluginCtx = {
    config: config,
    sys: config.sys,
    fs: compilerCtx.fs,
    cache: compilerCtx.cache,
    diagnostics: [],
  };

  const transformResults = {
    code,
    id,
    map: undefined as d.SourceMap | undefined,
    diagnostics: [] as d.Diagnostic[],
    dependencies: [] as string[],
  } satisfies d.PluginTransformResults;

  const isRawCssFile = id.toLowerCase().endsWith('.css');
  if (isRawCssFile) {
    // concat all css @imports into one file
    // when the entry file is a .css file (not .scss)
    // do this BEFORE transformations on css files
    const cssParseResults = await parseCssImports(config, compilerCtx, buildCtx, id, id, transformResults.code);
    transformResults.code = cssParseResults.styleText;
    if (Array.isArray(cssParseResults.imports)) {
      transformResults.dependencies.push(...cssParseResults.imports);
    }
    transformResults.map = cssParseResults.map;
  }

  for (const plugin of pluginCtx.config?.plugins ?? []) {
    if (isFunction(plugin.transform)) {
      try {
        let pluginTransformResults: d.PluginTransformResults | string;
        const results = plugin.transform(transformResults.code, transformResults.id, pluginCtx);
        if (results != null) {
          if (isFunction((results as any).then)) {
            pluginTransformResults = await results;
          } else {
            pluginTransformResults = results as d.PluginTransformResults;
          }

          if (pluginTransformResults != null) {
            if (isString(pluginTransformResults)) {
              transformResults.code = pluginTransformResults as string;
            } else {
              if (isString(pluginTransformResults.code)) {
                transformResults.code = pluginTransformResults.code;
              }
              if (isString(pluginTransformResults.id)) {
                transformResults.id = pluginTransformResults.id;
              }
              if (pluginTransformResults.map != null) {
                transformResults.map = mergePluginSourceMaps(transformResults.map, pluginTransformResults.map);
              }
              if (Array.isArray(pluginTransformResults.dependencies)) {
                const imports = pluginTransformResults.dependencies.filter(
                  (f) => !transformResults.dependencies.includes(f),
                );
                transformResults.dependencies.push(...imports);
              }
            }
          }
        }
      } catch (e: any) {
        catchError(transformResults.diagnostics, e);
      }
    }
  }

  transformResults.diagnostics.push(...pluginCtx.diagnostics);

  if (!isRawCssFile) {
    // precompilers just ran and converted @import "my.css" into @import url("my.css")
    // because of the ".css" extension. Precompilers did NOT concat the ".css" files into
    // the output but only updated it to use url() instead. Let's go ahead and concat
    // the url() css files into one file like we did for raw .css files. Do this
    // AFTER transformations on non-css files
    const cssParseResults = await parseCssImports(
      config,
      compilerCtx,
      buildCtx,
      id,
      transformResults.id,
      transformResults.code,
      null,
      transformResults.map,
    );
    transformResults.map = cssParseResults.map;
    transformResults.code = cssParseResults.styleText;
    if (Array.isArray(cssParseResults.imports)) {
      const imports = cssParseResults.imports.filter((f) => !transformResults.dependencies.includes(f));
      transformResults.dependencies.push(...imports);
    }
  }

  return transformResults;
};

const mergePluginSourceMaps = (previousMap: string | d.SourceMap | undefined, nextMap: string | d.SourceMap) => {
  const parsedNextMap = parsePluginSourceMap(nextMap);
  if (!previousMap) {
    return parsedNextMap;
  }
  return sourceMapMerge(parsePluginSourceMap(previousMap), parsedNextMap);
};

const parsePluginSourceMap = (map: string | d.SourceMap): d.SourceMap => {
  if (typeof map !== 'string') {
    return map;
  }

  const encodedMap = map.match(/^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (encodedMap) {
    const json = encodedMap[1] ? Buffer.from(encodedMap[2], 'base64').toString() : decodeURIComponent(encodedMap[2]);
    return JSON.parse(json);
  }

  return JSON.parse(map);
};
