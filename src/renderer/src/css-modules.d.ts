// Ambient typing for CSS Modules (Vite resolves the real class map at build).
declare module "*.module.css" {
  const classes: { readonly [key: string]: string }
  export default classes
}
