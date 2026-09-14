#!/usr/bin/env bash
#
# check-qml.sh — deterministic QML code-quality gate for the Symmetria FM.
#
# QML has no single "Knip + ESLint" like the JS/TS world. This runner assembles
# an equivalent from the Qt tools plus two small heuristics that fill the gaps:
#
#   1. LINT (bad practices)      — qmllint, using the project .qmllint.ini
#                                  (unqualified access, unused IMPORTS, deprecations,
#                                  type errors, signal-handler mistakes, …).
#   2. GOD FILES (size)          — flag .qml files over a line threshold.
#   3. DEAD COMPONENTS (unused)  — flag *.qml components never referenced anywhere
#                                  else in the tree (the cross-file "unused code"
#                                  that qmllint cannot see). Public API exported
#                                  via qmldir + the FileManager entry are excluded.
#   4. FORMAT DRIFT (optional)   — `--format` adds a qmlformat consistency check.
#
# Usage:
#   tools/quality/check-qml.sh                       # full tree: lint + god files + dead code
#   tools/quality/check-qml.sh a.qml b.qml           # SCOPED: lint/god-check only these files
#                                                    #   (used by /seal on a commit's changed QML;
#                                                    #    dead-component scan stays full-tree)
#   tools/quality/check-qml.sh --with-callers a.qml  # SCOPED + every file that references the
#                                                    #   changed component(s) by name. Use when a
#                                                    #   change edits a SHARED component's public API
#                                                    #   (a property/signal callers depend on): a
#                                                    #   removed/renamed property is a type error the
#                                                    #   linter only sees at the CALL site, not in the
#                                                    #   component itself. Catches the cross-file break
#                                                    #   statically, before any service restart.
#   tools/quality/check-qml.sh --format              # also report qmlformat drift
#   QML_GODFILE_LINES=400 tools/quality/check-qml.sh # stricter god-file bar
#
# Exit code is non-zero if any check finds a problem (suitable for CI / seal / pre-commit).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
QML_DIR="$ROOT/qml"
QMLLINT="/usr/lib/qt6/bin/qmllint"
QMLFORMAT="/usr/lib/qt6/bin/qmlformat"
GODFILE_LINES="${QML_GODFILE_LINES:-500}"
DO_FORMAT=0
WITH_CALLERS=0
SCOPED_FILES=()
for arg in "$@"; do
  case "$arg" in
    --format) DO_FORMAT=1 ;;
    --with-callers) WITH_CALLERS=1 ;;
    *.qml)
      if [ -f "$arg" ]; then
        SCOPED_FILES+=("$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")")
      else
        echo "warning: file not found, skipping: $arg" >&2
      fi ;;
    *) echo "warning: ignoring unknown arg: $arg" >&2 ;;
  esac
done

# --with-callers requires at least one .qml file to chase. Warn early rather
# than silently falling through to full-tree mode and doing nothing useful.
if [ "$WITH_CALLERS" -eq 1 ] && [ ${#SCOPED_FILES[@]} -eq 0 ]; then
  echo "error: --with-callers requires at least one .qml file argument" >&2
  echo "usage: $0 --with-callers <changed-component.qml> [...]" >&2
  exit 1
fi

status=0
hr() { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }

# Scoped mode (file args) lints/god-checks ONLY those files — how /seal isolates
# a change's new issues from the repo's pre-existing baseline. The dead-component
# scan always runs over the whole tree (orphaning can only be judged globally).
if [ ${#SCOPED_FILES[@]} -gt 0 ]; then
  QML_FILES=("${SCOPED_FILES[@]}")
  if [ "$WITH_CALLERS" -eq 1 ]; then
    # Expand the scope to every file that references a changed component by name.
    # A component's name is its PascalCase basename; QML instantiates it by that
    # bare name (e.g. `FileIcon { ... }`), so a whole-word grep across the tree
    # finds the call sites. We deliberately over-include (a comment mention also
    # matches) — linting a few extra files is harmless; MISSING a caller is the
    # bug this mode exists to prevent.
    declare -A _seen=()
    for f in "${SCOPED_FILES[@]}"; do _seen["$f"]=1; done
    added=0
    for f in "${SCOPED_FILES[@]}"; do
      comp="$(basename "$f" .qml)"
      # Only component-like (PascalCase) names act as shared types worth chasing.
      case "$comp" in [A-Z]*) ;; *) continue ;; esac
      while IFS= read -r caller; do
        [ -n "$caller" ] || continue
        abs="$(cd "$(dirname "$caller")" && pwd)/$(basename "$caller")"
        if [ -z "${_seen[$abs]:-}" ]; then
          _seen["$abs"]=1
          QML_FILES+=("$abs")
          added=$((added + 1))
        fi
      done < <(grep -rlE "\\b${comp}\\b" "$QML_DIR" --include='*.qml' 2>/dev/null)
    done
    echo "Scanning ${#QML_FILES[@]} .qml file(s): ${#SCOPED_FILES[@]} changed + ${added} caller(s) [scoped + callers mode]"
  else
    echo "Scanning ${#QML_FILES[@]} specified .qml file(s) [scoped mode]"
  fi
else
  mapfile -t QML_FILES < <(find "$QML_DIR" -name '*.qml' | sort)
  echo "Scanning ${#QML_FILES[@]} .qml files under qml/ [full tree]"
fi

# ── 1. LINT ────────────────────────────────────────────────────────────────
hr "1. qmllint (bad practices, unused imports, type errors)"
# Run from ROOT so qmllint auto-discovers .qmllint.ini (which sets the import path).
# Info-level output (the intentionally-demoted MissingProperty false positives
# from var-typed singletons — see .qmllint.ini) is NOISE for a gate; show and
# judge only Warning/Error lines.
lint_out="$( cd "$ROOT" && "$QMLLINT" "${QML_FILES[@]}" 2>&1 )"
lint_actionable="$(printf '%s\n' "$lint_out" | grep -E '^(Warning|Error):' || true)"

# Caller-aware scoping (--with-callers): the caller files were pulled into the
# lint set ONLY to surface cross-file API breaks (the "Could not find property"
# promotion below), which is judged tree-wide. Their OWN pre-existing
# Warning/Error lines are not this change's responsibility — a caller's baseline
# warning is not a regression introduced here — so restrict the BLOCKING set to
# the originally-changed files. Suppressed caller warnings are reported as a
# non-blocking informational note (transparency). grep -F treats the
# newline-joined scoped paths as an OR-set of fixed strings; each qmllint line
# embeds the absolute file path, so a path match cleanly partitions the lines.
caller_warnings=""
if [ "$WITH_CALLERS" -eq 1 ] && [ ${#SCOPED_FILES[@]} -gt 0 ] && [ -n "$lint_actionable" ]; then
  scoped_paths="$(printf '%s\n' "${SCOPED_FILES[@]}")"
  caller_warnings="$(printf '%s\n' "$lint_actionable" | grep -Fv "$scoped_paths" || true)"
  lint_actionable="$(printf '%s\n' "$lint_actionable" | grep -F "$scoped_paths" || true)"
fi

# Promote ONE diagnostic back out of the demoted-to-Info bucket: assigning a
# property that a component type does not declare ("Could not find property X").
# .qmllint.ini demotes the whole missing-property category to Info because member
# READS on var-typed singletons (FmTheme.palette.*) are unavoidable false
# positives — but the property-ASSIGNMENT form is a REAL cross-file API break: a
# caller setting a property that was removed/renamed on a shared component (at
# runtime this is the fatal "Cannot assign to non-existent property" that aborts
# the QML load). The two are distinguishable by message text — the noise reads
# 'Member "x" not found on type', this reads 'Could not find property' — and the
# clean tree has ZERO of the latter, so failing on it adds no false positives.
# Pair with --with-callers so a changed component's call sites are actually in
# scope. This stays TREE-WIDE (all linted files, callers included) even under the
# caller-warning scoping above — catching the break at the caller IS the point.
prop_break="$(printf '%s\n' "$lint_out" | grep -E 'Could not find property' || true)"

combined="$(printf '%s\n%s\n' "$lint_actionable" "$prop_break" | grep -E '.' || true)"
if [ -n "$combined" ]; then
  [ -n "$lint_actionable" ] && printf '%s\n' "$lint_actionable"
  if [ -n "$prop_break" ]; then
    printf '%s\n' "$prop_break"
    echo "   ↑ assignment to a property the component type does not declare."
    echo "     Likely a removed/renamed property on a shared component — fix the"
    echo "     call site(s), or re-add the property. (Run with --with-callers.)"
  fi
  echo "❌ qmllint: $(printf '%s\n' "$combined" | wc -l) warning/error line(s)"
  status=1
else
  info_n="$(printf '%s\n' "$lint_out" | grep -cE '^Info:' || true)"
  echo "✅ qmllint clean (no warnings/errors; ${info_n} demoted info notes hidden)"
fi

# Non-blocking: pre-existing Warning/Error lines in caller files (only populated
# in --with-callers mode). Shown so the user sees them without the gate failing.
if [ -n "$caller_warnings" ]; then
  echo "ℹ  $(printf '%s\n' "$caller_warnings" | wc -l) pre-existing warning(s) in caller files (not blocking):"
  printf '%s\n' "$caller_warnings" | sed 's/^/     /'
fi

# ── 2. GOD FILES ───────────────────────────────────────────────────────────
hr "2. God files (> ${GODFILE_LINES} lines)"
god_found=0
while read -r n f; do
  if [ "$n" -gt "$GODFILE_LINES" ]; then
    printf '❌ %5d  %s\n' "$n" "${f#"$ROOT"/}"
    god_found=1
  fi
done < <(wc -l "${QML_FILES[@]}" | sed '$d' | sort -rn)
if [ "$god_found" -eq 0 ]; then
  echo "✅ no file over ${GODFILE_LINES} lines"
else
  echo "   → consider decomposing into smaller components."
  status=1
fi

# ── 3. DEAD COMPONENTS ─────────────────────────────────────────────────────
hr "3. Dead components (defined but never referenced)"
python3 - "$ROOT" "$QML_DIR" <<'PY'
import sys, re, pathlib
root, qml_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
qml_files = sorted(qml_dir.rglob("*.qml"))

# Public API is anything a qmldir exports (it can be used by an external host —
# e.g. the Symmetria IDE imports the UI module), plus the embeddable entry point.
public = {"FileManager"}
for qmldir in qml_dir.rglob("qmldir"):
    for line in qmldir.read_text(errors="ignore").splitlines():
        parts = line.split()
        if not parts or parts[0].startswith("#"):
            continue
        # forms:  Name <ver> File.qml   |   singleton Name <ver> File.qml
        toks = parts[1:] if parts[0] in ("singleton", "internal") else parts
        if toks and toks[0][:1].isupper():
            public.add(toks[0])

# Concatenate every QML + JS source once; a component is "used" if its name
# appears as a whole word in any file other than its own definition.
sources = {p: p.read_text(errors="ignore") for p in qml_files}
for js in qml_dir.rglob("*.js"):
    sources[js] = js.read_text(errors="ignore")

dead = []
for f in qml_files:
    name = f.stem
    if name in public:
        continue
    pat = re.compile(r"\b" + re.escape(name) + r"\b")
    used = any(pat.search(txt) for p, txt in sources.items() if p != f)
    if not used:
        dead.append(f.relative_to(root))

if dead:
    print("❌ candidates (verify — may be loaded dynamically via Qt.createComponent):")
    for d in dead:
        print(f"   {d}")
    sys.exit(1)
else:
    print("✅ every component is referenced somewhere")
PY
[ $? -ne 0 ] && status=1

# ── 4. FORMAT DRIFT (optional) ─────────────────────────────────────────────
if [ "$DO_FORMAT" -eq 1 ]; then
  hr "4. qmlformat drift (--format)"
  drift=0
  for f in "${QML_FILES[@]}"; do
    if ! "$QMLFORMAT" "$f" | diff -q - "$f" >/dev/null 2>&1; then
      echo "✎ not qmlformat-clean: ${f#"$ROOT"/}"
      drift=1
    fi
  done
  if [ "$drift" -eq 0 ]; then echo "✅ all files qmlformat-clean"; else
    echo "   → run: qmlformat -i <file>   (note: adopting qmlformat is a style decision)"
    status=1
  fi
fi

hr "Result"
[ "$status" -eq 0 ] && echo "✅ all QML quality checks passed" || echo "❌ issues found (exit $status)"
exit "$status"
