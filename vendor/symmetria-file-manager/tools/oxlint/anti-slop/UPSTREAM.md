# Vendored anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop

Commit: `6d538555cb151d4121ed51a27db81890eacf8ae9`

License: MIT; see `LICENSE` in this directory.

`MANIFEST.sha256` verifies the upstream production TypeScript files and license. `package.json` is
a catalog-owned ESM boundary and is intentionally outside that upstream manifest.

This project-owned copy can diverge when its policy requires different behavior. Compare local
changes before replacing it during a catalog upgrade.
