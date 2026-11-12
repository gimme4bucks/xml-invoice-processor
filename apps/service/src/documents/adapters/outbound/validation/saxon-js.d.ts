// saxon-js ships without type declarations; this covers the part the Schematron worker uses.
declare module 'saxon-js' {
  interface TransformOptions {
    stylesheetInternal: unknown;
    sourceNode: unknown;
    destination: 'document';
  }

  const SaxonJS: {
    getResource(options: { text: string; type: 'xml' }): Promise<unknown>;
    transform(options: TransformOptions, mode: 'sync'): { principalResult: unknown };
    XPath: {
      evaluate(
        xpath: string,
        context: unknown,
        options?: { namespaceContext?: Record<string, string> },
      ): unknown;
    };
  };
  export default SaxonJS;
}
