import { type E2EPage, newE2EPage } from '@stencil/core/testing';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { readFileSync } from 'fs';
import { resolve } from 'path';

type CSSCoverageEntry = Awaited<ReturnType<E2EPage['coverage']['stopCSSCoverage']>>[number];

/**
 * Converts an offset in a text to a 1-based line and 0-based column (the format source maps use)
 */
function offsetToPosition(text: string, offset: number) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length };
}

describe('css source maps', () => {
  let globalCss: CSSCoverageEntry;
  let traceMap: TraceMap;
  let rawMap: { sources: string[]; sourcesContent: string[] };

  /**
   * Maps the first match of `needle` in the generated stylesheet back to its original source line
   */
  function originalLineFor(needle: RegExp) {
    const offset = globalCss.text.search(needle);
    expect(offset).toBeGreaterThan(-1);

    const generated = offsetToPosition(globalCss.text, offset);
    const original = originalPositionFor(traceMap, generated);
    expect(original.source).not.toBeNull();

    // the global stylesheet has exactly one source
    return { original, text: rawMap.sourcesContent[0].split('\n')[original.line - 1] };
  }

  beforeAll(async () => {
    const page = await newE2EPage();

    // coverage tells us which parts of the generated stylesheet the browser actually applied
    await page.coverage.startCSSCoverage();
    await page.goto('/');
    await page.waitForChanges();
    const coverage = await page.coverage.stopCSSCoverage();

    globalCss = coverage.find((entry) => entry.url.endsWith('/build/endtoend.css'));

    // fetch the source map the generated stylesheet points to
    const mapUrl = /\/\*# sourceMappingURL=(\S+) \*\//.exec(globalCss.text)?.[1];
    expect(mapUrl).toBe('endtoend.css.map');

    const mapText = await page.evaluate(async (url: string) => (await fetch(url)).text(), `/build/${mapUrl}`);
    rawMap = JSON.parse(mapText);
    traceMap = new TraceMap(mapText);
  });

  it('links the global stylesheet to its source map', () => {
    expect(globalCss).toBeDefined();
    expect(rawMap.sources).toHaveLength(1);
    expect(rawMap.sources[0].endsWith('src/global.css')).toBe(true);
    expect(rawMap.sourcesContent[0]).toContain('border: 5px dotted red');
  });

  it('maps every used rule of the global stylesheet back to global.css', () => {
    expect(globalCss.ranges.length).toBeGreaterThan(0);

    for (const range of globalCss.ranges) {
      const generated = offsetToPosition(globalCss.text, range.start);
      const original = originalPositionFor(traceMap, generated);

      expect(original.source?.endsWith('src/global.css')).toBe(true);
      expect(original.line).toBeGreaterThan(0);
    }
  });

  it('maps the selector back to the correct original line and column', () => {
    const { original, text } = originalLineFor(/app-root/);

    // global.css starts with an empty line, so the selector is on line 2
    expect(original.line).toBe(2);
    expect(original.column).toBe(0);
    expect(text).toBe('app-root {');
  });

  it.each([
    ['display', 'display: block'],
    ['margin', 'margin: 10px'],
    ['padding', 'padding: 20px'],
    ['border', 'border: 5px dotted red'],
  ])('maps the generated `%s` declaration back to its original line', (property, originalDeclaration) => {
    // whitespace tolerant, so the test also works if the generated css gets minified
    const { text } = originalLineFor(new RegExp(`${property}:\\s*`));

    expect(text.trim()).toBe(`${originalDeclaration};`);
  });
});

/**
 * Component styles don't go through the global style pipeline: the css is embedded in the lazy entry module
 * and the source map is emitted next to it, so they need to be checked separately.
 */
describe('css source maps of component entries', () => {
  let cssText: string;
  let traceMap: TraceMap;
  let rawMap: { sources: string[]; sourcesContent: string[] };

  /**
   * Reads an original css file from disk, the source map has to point back to the lines in these files
   */
  function readOriginal(fileName: string) {
    return readFileSync(resolve(__dirname, '../car-list', fileName), 'utf8').split('\n');
  }

  /**
   * Maps the first match of `needle` in the generated css back to its original position and source content
   */
  function mapBack(needle: RegExp) {
    const offset = cssText.search(needle);
    expect(offset).toBeGreaterThan(-1);

    const original = originalPositionFor(traceMap, offsetToPosition(cssText, offset));
    expect(original.source).not.toBeNull();

    const sourceIndex = rawMap.sources.findIndex((s) => s === original.source || original.source.endsWith(s));
    expect(sourceIndex).toBeGreaterThan(-1);

    const sourceLines = rawMap.sourcesContent[sourceIndex].split('\n');
    return { original, sourceLines, sourceText: sourceLines[original.line - 1] };
  }

  beforeAll(async () => {
    const page = await newE2EPage();
    await page.goto('/');
    await page.waitForChanges();

    // the lazy entry module holds the component css as a template literal and links the source map via url
    const entryJs = await page.evaluate(async () => (await fetch('/build/car-list.entry.js')).text());
    cssText = /`([^`]*:host[^`]*)`/.exec(entryJs)?.[1];
    expect(cssText).toBeDefined();

    const mapFile = /([\w.$-]+\.css\.map)/.exec(entryJs)?.[1];
    expect(mapFile).toBeDefined();

    const mapText = await page.evaluate(async (url: string) => (await fetch(url)).text(), `/build/${mapFile}`);
    rawMap = JSON.parse(mapText);
    traceMap = new TraceMap(mapText);
  });

  it('references the entry css file and the file it imports as sources', () => {
    expect(rawMap.sources.some((s) => s.endsWith('src/car-list/car-list.css'))).toBe(true);
    expect(rawMap.sources.some((s) => s.endsWith('src/car-list/car-list-imported.css'))).toBe(true);
  });

  it.each([
    // [generated css, original file, text of the original line]
    ['.imported-rule', 'car-list-imported.css', '.imported-rule {'],
    [':host', 'car-list.css', ':host {'],
    ['ul', 'car-list.css', 'ul {'],
    ['li', 'car-list.css', 'li {'],
    ['.selected', 'car-list.css', '.selected {'],
  ])('maps the selector `%s` back to %s', (selector, fileName, originalLine) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const { original, sourceText } = mapBack(new RegExp(`(?<=^|[}\\s])${escaped}(?=\\s*\\{)`));

    expect(original.source.endsWith(`src/car-list/${fileName}`)).toBe(true);
    expect(original.column).toBe(0);
    expect(sourceText).toBe(originalLine);

    // the line number has to match the line in the file on disk, not just in the embedded sources content
    expect(readOriginal(fileName)[original.line - 1]).toBe(originalLine);
  });

  it.each([
    ['letter-spacing', 'car-list-imported.css'],
    ['outline', 'car-list-imported.css'],
    ['list-style', 'car-list.css'],
    ['font-weight', 'car-list.css'],
    ['background', 'car-list.css'],
    ['border', 'car-list.css'],
  ])('maps the declaration `%s` back to %s', (property, fileName) => {
    // whitespace tolerant, so the test also works if the generated css gets minified
    const { original, sourceText } = mapBack(new RegExp(`${property}:\\s*`));

    expect(original.source.endsWith(`src/car-list/${fileName}`)).toBe(true);
    expect(sourceText.trim().startsWith(`${property}:`)).toBe(true);
    expect(readOriginal(fileName)[original.line - 1]).toBe(sourceText);
  });
});
