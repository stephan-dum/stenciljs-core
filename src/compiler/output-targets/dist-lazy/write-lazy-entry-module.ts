import { FsWriteResults } from '@stencil/core/compiler';
import { getSourceMappingUrlForEndOfFile, join } from '@utils';

import type * as d from '../../../declarations';

export const writeLazyModule = async (
  compilerCtx: d.CompilerCtx,
  outputTargetType: string,
  destinations: string[],
  code: string,
  sourceMap: d.SourceMap,
  rollupResult: d.RollupChunkResult,
  format: d.Format,
): Promise<d.BundleModuleOutput> => {
  const fileName = rollupResult.fileName;
  const bundleId = fileName.replace('.entry.js', '');

  if (sourceMap) {
    code = code + getSourceMappingUrlForEndOfFile(fileName);
  }

  const writes: Promise<FsWriteResults>[] = [];

  for (const [mode, sourceMaps] of rollupResult.sourceMapsByMode.entries()) {
    Object.values(sourceMaps).forEach((sourceMap, i) => {
      const mapReference = `./${fileName}.${mode}.${i}.css.map`;

      destinations.forEach((destination) => {
        writes.push(compilerCtx.fs.writeFile(join(destination, mapReference), sourceMap));
      });

      const url = format === 'cjs' ? `'file://' + __filename` : 'import.meta.url';
      const runtimeUrlExpression = `new URL('${mapReference}', ${url}).href`;
      code = code.replace(`"__@SOURCE_MAP_${mode}_${i}@__"`, runtimeUrlExpression);
    });
  }

  destinations.forEach((dst) => {
    const jsPath = join(dst, fileName);
    const mapPath = jsPath + '.map';
    writes.push(compilerCtx.fs.writeFile(jsPath, code, { outputTargetType }));
    if (!!sourceMap) {
      writes.push(compilerCtx.fs.writeFile(mapPath, JSON.stringify(sourceMap), { outputTargetType }));
    }
  });

  await Promise.all(writes);

  return {
    bundleId,
    fileName,
    code,
  };
};
