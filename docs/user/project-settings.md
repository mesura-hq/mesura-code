# Settings and project overrides

The Settings breadcrumb ends with the environment and project a change applies to. They start
at **All environments** and **All projects** and stay selected as you move between categories or
search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Browser access changes apply when an agent session next starts.

## Portable repository defaults

Create `.mesura.json` at the repository root in your code editor. For example:

```json
{
  "version": 1,
  "iconPath": "assets/logo.svg",
  "defaultModelSelection": {
    "provider": "codex",
    "model": "gpt-6-astra",
    "options": [{ "id": "reasoningEffort", "value": "high" }]
  },
  "defaultThreadEnvMode": "worktree"
}
```

Keep `version` set to `1`. The other fields are optional. Set `iconPath` to an existing
image inside the checkout, relative to its root. Use forward slashes, not an absolute path.
Set `defaultThreadEnvMode` to `"worktree"` for a new Git worktree or `"local"` for the current checkout.

Use a provider kind, such as `codex`, and a model available on each environment where you use
the project. Mesura Code resolves the model through that environment's enabled default provider
instance and keeps only supported options. If the model is unavailable there, it uses an available
fallback. If no usable model exists, select or configure a provider before starting work.

Commit `.mesura.json` and the referenced image to carry these defaults with the repository.
They apply on machines and checkouts that contain the file. Each environment still needs its own
provider setup. Mesura Code reads the file. It does not create, edit, commit, or synchronize it.

Save changes in your code editor, then start a new thread from that checkout. Existing threads
keep their selections. Choosing a model in one thread does not change `.mesura.json` or set the
repository default.

New-thread defaults resolve each field in this order:

1. An explicit choice in the draft.
2. The field in `.mesura.json`.
3. The machine-local project default.
4. The field in `t3.json`, where supported, such as `defaultThreadEnvMode`.
5. The environment default, then the built-in default.

The model and workspace controls in **Settings** still save machine-local values on the selected
environments. They do not edit `.mesura.json` or show its values. A valid file field takes priority.
Omitting a field preserves its fallback. Keep scripts in `t3.json`; they continue to work alongside
`.mesura.json`. A missing or invalid `.mesura.json` uses the existing defaults and icon detection.
An invalid value in any field makes Mesura Code ignore the whole file, including its other valid fields.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image for the project group.
For images, each checkout uses the first available file: `iconPath` in `.mesura.json`, the saved image,
`iconPath` in `t3.json`, then automatic detection. Thus, a valid repository image overrides an image
chosen in Settings. Choose **Automatic** to clear the saved choice and use repository images or detection.

On web and desktop, an explicit icon, emoji, or monogram choice takes priority over these images.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
