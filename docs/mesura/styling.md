# Styling overrides

This fork carries one app-wide stylesheet of its own: `apps/web/src/mesura.css`. Read this before
concluding that a style in `apps/web/src/index.css` is in force, and before adding a rule of your
own. A second, component-scoped one, `apps/web/src/components/files/mesuraTree/fileTree.css`, is
imported by the file tree alone and follows the same constraints; see the end of this document.

## Why it exists

Upstream owns `index.css` and rewrites parts of it often. Changing a declaration there is a merge
conflict every week for as long as the difference survives. A separate file that only _overrides_ is
free at merge time, and it keeps the whole set of fork-specific styles greppable in one place
instead of scattered through 80k of upstream CSS.

## How it loads

`apps/web/src/main.tsx` imports it immediately after `index.css`. That import is the fork's only
line inside upstream's entry point, and `main.tsx` is the sole entry that imports either stylesheet
— desktop wraps the same web bundle. Mobile is React Native and has no CSS, so nothing here reaches
it.

## Constraints

**Plain CSS only.** Tailwind processes `index.css` alone, so `@variant`, `@apply`, and `@theme` do
nothing here. Upstream declares `@custom-variant dark (&:is(.dark, .dark *))`, so the dark-mode form
in this file is a plain `.dark <selector>` prefix.

**Never wrap this file in a `@layer`.** Upstream's component rules sit in `@layer components`, and
an unlayered rule outranks any layered one whatever its specificity. That is the guarantee that
makes these overrides win without depending on import order. Wrapping the file hands the decision
back to specificity alone and silently weakens every rule in it.

**Scope every rule, and say why in a comment.** An override that matches broadly is how a fork stops
being able to take upstream's redesigns: the next upstream change lands, the override quietly
suppresses it, and nobody connects the two. Each rule should name the upstream rule it fights, the
attribute or class it hooks, and what happens if upstream removes that hook.

**Prefer hooks upstream tests.** Where the selector depends on an upstream `data-` attribute, check
whether an upstream test asserts on it. One that does cannot be renamed there without failing, which
turns a silent break into a caught one.

## What is in it today

- The drawer holding the agent's question renders neutral instead of upstream's `info` blue. Upstream
  tags the composer's top drawer `data-variant="info"`; the question is not a notice, and the tint
  put it out of line with the composer directly below it. The rule restores the two custom properties
  upstream's variant-less base rule sets, scoped by `:has()` to the drawer that actually holds a
  question so the plan follow-up banner keeps its tint.

## The file tree's stylesheet

`apps/web/src/components/files/mesuraTree/fileTree.css` is imported by `MesuraFileTree.tsx` and
holds only what the vendored file manager's stylesheets need on top of `index.css`: the icon
palette and the six glass tokens those stylesheets read and `index.css` lacks, the panel's type
size and layout, and the overview layer's position and stacking above the panel. Every rule is
scoped to the tree's wrapper, `[data-mesura-file-tree]`, or to the overview's,
`[data-mesura-folder-overview]`; the vendored stylesheets themselves are never edited here.
