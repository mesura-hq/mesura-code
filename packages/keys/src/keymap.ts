import { parseKeySequence } from "./keyToken.ts";

/**
 * Keymaps: bindings per mode and per scope, compiled into key tries.
 *
 * **A key is a command or a prefix, never both** (Helix, Tridactyl, Vimium).
 * Inside one layer — one mode and one scope — a binding that would make a key
 * both is a conflict: it is reported and the later binding is dropped. Because
 * of this rule a pending prefix never has to time out to decide what the user
 * meant, which matches Symmetria's chord model ("there is no chord timeout,
 * and there never was").
 *
 * Across layers a deeper scope shadows an outer one: a scope that binds `g` as
 * a command hides every outer `g…` sequence while that scope has focus.
 */

export type KeyMode = "normal" | "visual" | "insert";

export interface KeyBinding {
  readonly mode: KeyMode | readonly KeyMode[];
  /** Absent: the binding applies in every scope. */
  readonly scope?: string;
  readonly keys: string;
  readonly command: string;
  /** What which-key shows; the host titles the command when absent. */
  readonly label?: string;
}

export interface KeyGroup {
  /** Absent: the label applies in every mode. */
  readonly mode?: KeyMode | readonly KeyMode[];
  readonly scope?: string;
  readonly keys: string;
  readonly label: string;
}

export interface KeymapConfig {
  readonly leader: string;
  readonly bindings: readonly KeyBinding[];
  readonly groups: readonly KeyGroup[];
}

export interface KeyLeaf {
  readonly kind: "leaf";
  readonly command: string;
  readonly label: string | undefined;
}

export interface KeyNode {
  readonly kind: "node";
  readonly children: Map<string, KeyEntry>;
  label: string | undefined;
}

export type KeyEntry = KeyLeaf | KeyNode;

export interface KeymapConflict {
  readonly mode: KeyMode;
  readonly scope: string | undefined;
  readonly keys: string;
  readonly command: string;
  readonly reason: "prefix-of-existing" | "extends-existing-command" | "duplicate";
}

export interface CompiledKeymap {
  readonly leader: string;
  readonly conflicts: readonly KeymapConflict[];
  /** The merged trie for a mode and the active scopes, outermost first. */
  trieFor(mode: KeyMode, scopes: readonly string[]): KeyNode;
}

const ALL_MODES: readonly KeyMode[] = ["normal", "visual", "insert"];

function modesOf(mode: KeyMode | readonly KeyMode[] | undefined): readonly KeyMode[] {
  if (mode === undefined) return ALL_MODES;
  return typeof mode === "string" ? [mode] : mode;
}

function emptyNode(): KeyNode {
  return { kind: "node", children: new Map(), label: undefined };
}

function layerKey(mode: KeyMode, scope: string | undefined): string {
  return `${mode}|${scope ?? ""}`;
}

/** Inserts one binding into a layer; returns the conflict reason, if any. */
function insertBinding(
  layer: KeyNode,
  tokens: readonly string[],
  command: string,
  label: string | undefined,
): KeymapConflict["reason"] | null {
  let node = layer;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const last = index === tokens.length - 1;
    const existing = node.children.get(token);
    if (last) {
      if (existing?.kind === "node") return "prefix-of-existing";
      if (existing?.kind === "leaf") return "duplicate";
      node.children.set(token, { kind: "leaf", command, label });
      return null;
    }
    if (existing?.kind === "leaf") return "extends-existing-command";
    if (existing === undefined) {
      const child = emptyNode();
      node.children.set(token, child);
      node = child;
    } else {
      node = existing;
    }
  }
  return null;
}

function labelNode(layer: KeyNode, tokens: readonly string[], label: string): void {
  let node = layer;
  for (const token of tokens) {
    const existing = node.children.get(token);
    if (existing === undefined) {
      const child = emptyNode();
      node.children.set(token, child);
      node = child;
      continue;
    }
    if (existing.kind === "leaf") return;
    node = existing;
  }
  node.label = label;
}

/** Overlays `top` on `base`, deeper scope winning; returns a new trie. */
function overlay(base: KeyNode, top: KeyNode): KeyNode {
  const merged: KeyNode = {
    kind: "node",
    children: new Map(base.children),
    label: top.label ?? base.label,
  };
  for (const [token, entry] of top.children) {
    const under = merged.children.get(token);
    if (entry.kind === "leaf" || under === undefined || under.kind === "leaf") {
      merged.children.set(token, entry);
    } else {
      merged.children.set(token, overlay(under, entry));
    }
  }
  return merged;
}

export function compileKeymap(config: KeymapConfig): CompiledKeymap {
  const leader = parseKeySequence(config.leader)[0] ?? "<Space>";
  const layers = new Map<string, KeyNode>();
  const conflicts: KeymapConflict[] = [];
  const layerFor = (mode: KeyMode, scope: string | undefined) => {
    const key = layerKey(mode, scope);
    let layer = layers.get(key);
    if (layer === undefined) {
      layer = emptyNode();
      layers.set(key, layer);
    }
    return layer;
  };

  for (const binding of config.bindings) {
    const tokens = parseKeySequence(binding.keys, leader);
    if (tokens.length === 0) continue;
    for (const mode of modesOf(binding.mode)) {
      const reason = insertBinding(
        layerFor(mode, binding.scope),
        tokens,
        binding.command,
        binding.label,
      );
      if (reason !== null) {
        conflicts.push({
          mode,
          scope: binding.scope,
          keys: binding.keys,
          command: binding.command,
          reason,
        });
      }
    }
  }
  for (const group of config.groups) {
    const tokens = parseKeySequence(group.keys, leader);
    for (const mode of modesOf(group.mode)) {
      labelNode(layerFor(mode, group.scope), tokens, group.label);
    }
  }

  const merged = new Map<string, KeyNode>();
  return {
    leader,
    conflicts,
    trieFor(mode, scopes) {
      const cacheKey = `${mode}|${scopes.join(">")}`;
      const cached = merged.get(cacheKey);
      if (cached !== undefined) return cached;
      let trie = layers.get(layerKey(mode, undefined)) ?? emptyNode();
      for (const scope of scopes) {
        const layer = layers.get(layerKey(mode, scope));
        if (layer !== undefined) trie = overlay(trie, layer);
      }
      merged.set(cacheKey, trie);
      return trie;
    },
  };
}

/** The entry a token sequence reaches, or undefined when it leaves the trie. */
export function walkKeys(trie: KeyNode, tokens: readonly string[]): KeyEntry | undefined {
  let entry: KeyEntry = trie;
  for (const token of tokens) {
    if (entry.kind === "leaf") return undefined;
    const next = entry.children.get(token);
    if (next === undefined) return undefined;
    entry = next;
  }
  return entry;
}

export interface WhichKeyRow {
  readonly token: string;
  /** The group's or binding's label; the caller titles a bare command. */
  readonly label: string | undefined;
  readonly command: string | undefined;
  readonly isGroup: boolean;
}

/** The rows a which-key popup shows for a pending node, groups first. */
export function whichKeyRows(node: KeyNode): WhichKeyRow[] {
  const rows: WhichKeyRow[] = [];
  for (const [token, entry] of node.children) {
    rows.push(
      entry.kind === "leaf"
        ? { token, label: entry.label, command: entry.command, isGroup: false }
        : { token, label: entry.label, command: undefined, isGroup: true },
    );
  }
  return rows.toSorted((left, right) => {
    if (left.isGroup !== right.isGroup) return left.isGroup ? -1 : 1;
    return left.token.localeCompare(right.token);
  });
}
