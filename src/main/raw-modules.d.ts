// Vite's `?raw` import suffix yields a module's file contents as a string. Used
// on the main side to inline generated-helper sources into the bundle.
declare module "*?raw" {
  const content: string
  export default content
}
