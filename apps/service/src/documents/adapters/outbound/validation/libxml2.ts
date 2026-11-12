import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

export type Libxml2 = typeof import('libxml2-wasm');

/**
 * libxml2-wasm is an ES module with top-level await (it instantiates the WASM binary), so the
 * CommonJS build cannot `require()` it, and swc compiles a plain `import()` into `require()`.
 * This `import()` is compiled by Node itself and resolved by its default ESM loader, both in
 * the build and under vitest.
 */
const nativeImport = new vm.Script('(specifier) => import(specifier)', {
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}).runInThisContext() as (specifier: string) => Promise<Libxml2>;

let loading: Promise<Libxml2> | undefined;

/** Loads libxml2-wasm once per process. */
export function loadLibxml2(): Promise<Libxml2> {
  loading ??= nativeImport(pathToFileURL(require.resolve('libxml2-wasm')).href);
  return loading;
}

/**
 * Parse options for untrusted XML: no network access and never load external entities or DTDs.
 * `XML_PARSE_NOENT` (entity substitution) must never be added.
 */
export function safeParseOptions(libxml: Libxml2): number {
  return libxml.ParseOption.XML_PARSE_NONET | libxml.ParseOption.XML_PARSE_NO_XXE;
}
