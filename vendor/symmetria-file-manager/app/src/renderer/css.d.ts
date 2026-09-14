// Side-effect CSS imports, for the compiler.
//
// A copy rather than a shared file: the panel package carries its own, and this
// is a one-line ambient declaration whose "duplication" is two independent
// compile contexts each needing to know the same fact about their bundler.
declare module "*.css";
