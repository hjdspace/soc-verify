/**
 * Type declarations for Vite's `?raw` imports in the main process.
 *
 * The main process tsconfig does not reference `vite/client`, so we declare
 * the `*?raw` module type here to allow importing file contents as strings
 * at build time (e.g. omp engine prompt templates).
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
