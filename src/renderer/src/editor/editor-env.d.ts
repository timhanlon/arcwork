/// <reference types="vite/client" />
// Brings in Vite's ambient module types — notably `*?worker`, the form
// `monaco-setup.ts` uses to bundle Monaco's web workers locally. The renderer's
// tsconfig sets `types: ["node"]`, so Vite's client types aren't auto-included;
// this reference pulls them in for the editor module without widening the
// global `types` list.
