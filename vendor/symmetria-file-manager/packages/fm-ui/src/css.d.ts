/**
 * A side-effect CSS import has no type of its own.
 *
 * Without this declaration `import "./styles.css"` is a compile error under
 * `moduleResolution: bundler`, because TypeScript looks for a module and finds
 * a stylesheet. The bundler handles the file; TypeScript only needs to be told
 * it exists.
 */
declare module "*.css";
