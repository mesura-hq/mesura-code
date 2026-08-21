// @effect-diagnostics nodeBuiltinImport:off - the recorded checksum is only
// meaningful against the bytes actually on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  canonicalizeJsonValue,
  computeSymmetriaContractChecksum,
  computeSymmetriaSourceChecksum,
  formatSymmetriaSchemaDocument,
} from "./checksum.ts";
import { buildSymmetriaJsonSchemaArtifacts, SYMMETRIA_SCHEMA_ROOTS } from "./jsonSchema.ts";

const schemaDirectory = new URL("../schema/", import.meta.url);

const readRecordedIndex = (): Readonly<Record<string, unknown>> =>
  JSON.parse(NodeFS.readFileSync(new URL("index.json", schemaDirectory), "utf8")) as Readonly<
    Record<string, unknown>
  >;

const readEmittedEntries = () =>
  NodeFS.readdirSync(schemaDirectory)
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .sort()
    .map((file) => ({
      file,
      source: NodeFS.readFileSync(new URL(file, schemaDirectory), "utf8"),
    }));

describe("Symmetria contract checksum", () => {
  // This is the value a second repository pins, so it has to be reproducible
  // from the published bytes alone, with no access to this package's source.
  it("matches the value recorded in the index", () => {
    expect(readRecordedIndex().checksum).toBe(
      computeSymmetriaContractChecksum(readEmittedEntries()),
    );
  });

  it("frames the hash as path, NUL, bytes, NUL, in ascending path order", () => {
    const hash = NodeCrypto.createHash("sha256");
    for (const entry of readEmittedEntries()) {
      hash.update(entry.file, "utf8");
      hash.update("\0");
      hash.update(entry.source, "utf8");
      hash.update("\0");
    }
    expect(computeSymmetriaContractChecksum(readEmittedEntries())).toBe(hash.digest("hex"));
  });

  it("orders entries itself rather than trusting the caller", () => {
    const entries = readEmittedEntries();
    expect(computeSymmetriaContractChecksum(entries.toReversed())).toBe(
      computeSymmetriaContractChecksum(entries),
    );
  });

  // The hash has to be sensitive, not merely present: one changed character in
  // one document must move it.
  it("changes when any emitted document changes", () => {
    const entries = readEmittedEntries();
    const [first, ...rest] = entries;
    if (first === undefined) throw new Error("no emitted documents to hash");
    const mutated = [{ file: first.file, source: `${first.source} ` }, ...rest];
    expect(computeSymmetriaContractChecksum(mutated)).not.toBe(
      computeSymmetriaContractChecksum(entries),
    );
  });

  it("changes when a document is renamed but its bytes are not", () => {
    const entries = readEmittedEntries();
    const [first, ...rest] = entries;
    if (first === undefined) throw new Error("no emitted documents to hash");
    const renamed = [{ file: `renamed.${first.file}`, source: first.source }, ...rest];
    expect(computeSymmetriaContractChecksum(renamed)).not.toBe(
      computeSymmetriaContractChecksum(entries),
    );
  });

  // Canonicalisation is why a future Effect beta emitting the same schema with
  // its keys in another order does not read as a contract change.
  it("ignores object key order and keeps array order", () => {
    const value = { beta: [3, 1, 2], alpha: { second: true, first: false } };
    const reordered = { alpha: { first: false, second: true }, beta: [3, 1, 2] };
    expect(formatSymmetriaSchemaDocument(value)).toBe(formatSymmetriaSchemaDocument(reordered));
    expect(canonicalizeJsonValue(value)).toEqual(reordered);
    expect((canonicalizeJsonValue(value) as { beta: ReadonlyArray<number> }).beta).toEqual([
      3, 1, 2,
    ]);
  });

  // The blind spot the document checksum has on its own, measured rather than
  // argued: these two structs emit the same JSON Schema, and one of them
  // accepts an empty title while the other refuses it.
  it("moves on a schema change the emitted document cannot express", () => {
    const strict = Schema.Struct({ title: TrimmedNonEmptyString });
    const loose = Schema.Struct({ title: Schema.String });
    const documentOf = (schema: Schema.Top) =>
      JSON.stringify(Schema.toJsonSchemaDocument(schema, { additionalProperties: true }));
    expect(documentOf(strict)).toBe(documentOf(loose));
    expect(computeSymmetriaSourceChecksum([{ root: "R", ast: strict.ast }])).not.toBe(
      computeSymmetriaSourceChecksum([{ root: "R", ast: loose.ast }]),
    );
  });

  it("recomputes the recorded source checksum from the roots", () => {
    expect(
      computeSymmetriaSourceChecksum(
        SYMMETRIA_SCHEMA_ROOTS.map((root) => ({ root: root.root, ast: root.schema.ast })),
      ),
    ).toBe(readRecordedIndex().sourceChecksum);
  });

  it("gives the same source checksum twice and ignores entry order", () => {
    const entries = SYMMETRIA_SCHEMA_ROOTS.map((root) => ({
      root: root.root,
      ast: root.schema.ast,
    }));
    expect(computeSymmetriaSourceChecksum(entries)).toBe(computeSymmetriaSourceChecksum(entries));
    expect(computeSymmetriaSourceChecksum(entries.toReversed())).toBe(
      computeSymmetriaSourceChecksum(entries),
    );
  });

  it("survives a schema tree that refers back to itself", () => {
    const cyclic: Record<string, unknown> = { name: "node" };
    cyclic.self = cyclic;
    expect(computeSymmetriaSourceChecksum([{ root: "R", ast: cyclic }])).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes exactly what the emitted artifacts carry", () => {
    expect(
      computeSymmetriaContractChecksum(
        buildSymmetriaJsonSchemaArtifacts().map(({ file, source }) => ({ file, source })),
      ),
    ).toBe(readRecordedIndex().checksum);
  });
});
