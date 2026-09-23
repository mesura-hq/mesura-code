// @effect-diagnostics nodeBuiltinImport:off - drives repository tools and temporary compiler fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { BORROWED_RUNTIME_VOCABULARIES } from "../../packages/symmetria-broker-contract/src/upstreamLock.ts";
import {
  commandOutput,
  contractPackageRoot,
  expectSuccessfulCommand,
  repositoryRoot,
  run,
  typecheckerPath,
  vitePlusPath,
} from "./contractHarness.ts";

// ⚠ NO MOVER ESTE ARCHIVO DENTRO DE packages/symmetria-broker-contract.
//
// Abajo, este test lanza `vp test run` CONTRA ESE PAQUETE como subproceso, para
// comprobar desde afuera que su suite pasa. Si el archivo vive dentro del
// paquete, el comando lo recolecta, él relanza el comando, y eso lo recolecta de
// nuevo: recursión con abanico de procesos que agota la RAM. Probado el
// 2026-08-20 — el intento colgó 600 s y no emitió una sola línea.
//
// Su ubicación fuera del paquete es load-bearing, no un descuido. El costo
// conocido es que `vp run -r test` no lo recolecta, porque tests/ no es un
// paquete del workspace; la salida correcta es darle a tests/ su propio
// package.json y declararlo en pnpm-workspace.yaml, no mudar el archivo.
const acceptanceTestsRoot = NodePath.join(repositoryRoot, "tests");
type RuntimeVocabularyName = keyof typeof BORROWED_RUNTIME_VOCABULARIES;

const writeContractTypeShim = (
  directory: string,
  changedVocabulary?: {
    readonly name: RuntimeVocabularyName;
    readonly values: ReadonlyArray<string>;
  },
) => {
  const source = Object.entries(BORROWED_RUNTIME_VOCABULARIES)
    .map(([name, canonicalValues]) => {
      const values = changedVocabulary?.name === name ? changedVocabulary.values : canonicalValues;
      return `export type ${name} = ${values.map((value) => JSON.stringify(value)).join(" | ")};`;
    })
    .join("\n");
  const shimPath = NodePath.join(directory, "contracts-shim.ts");
  NodeFS.writeFileSync(shimPath, `${source}\n`);
  return shimPath;
};

const compileUpstreamLock = (
  directory: string,
  changedVocabulary?: {
    readonly name: RuntimeVocabularyName;
    readonly values: ReadonlyArray<string>;
  },
) => {
  const shimPath = writeContractTypeShim(directory, changedVocabulary);
  const configPath = NodePath.join(directory, "tsconfig.json");
  NodeFS.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        extends: NodePath.join(repositoryRoot, "tsconfig.base.json"),
        compilerOptions: {
          noEmit: true,
          paths: {
            "@t3tools/contracts": [shimPath],
          },
        },
        files: [NodePath.join(contractPackageRoot, "src/upstreamLock.ts")],
      },
      null,
      2,
    )}\n`,
  );
  return run(typecheckerPath, ["-p", configPath]);
};

// The phase implementation is present in this working tree. These checks are
// post-implementation regression guards, so each one must pass in this tree.
describe("Symmetria broker contract phase-one regression guards", () => {
  it("keeps the acceptance tests collected and typechecked as a workspace project", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(acceptanceTestsRoot, "package.json"), "utf8"),
    ) as {
      readonly name?: string;
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const workspaceSource = NodeFS.readFileSync(
      NodePath.join(repositoryRoot, "pnpm-workspace.yaml"),
      "utf8",
    );

    expect(manifest.name).toBe("@symmetria/acceptance-tests");
    expect(manifest.scripts?.test).toBe("vp test run");
    expect(manifest.scripts?.typecheck).toBe("tsc --noEmit");
    expect(workspaceSource).toMatch(/^\s*- tests\s*$/m);
    expectSuccessfulCommand(run(typecheckerPath, ["--noEmit"], acceptanceTestsRoot));
  });

  it("keeps the fork-owned package typecheck green with tsc --noEmit", () => {
    expect(NodeFS.existsSync(contractPackageRoot)).toBe(true);
    expectSuccessfulCommand(run(typecheckerPath, ["--noEmit"], contractPackageRoot));
  });

  it("keeps the package repair guards in its normal test suite", () => {
    expect(NodeFS.existsSync(contractPackageRoot)).toBe(true);
    const result = run(vitePlusPath, ["test", "run", "--reporter=verbose"], contractPackageRoot);
    expectSuccessfulCommand(result);
    const output = commandOutput(result);
    expect(output).toContain("src/upstreamLockFiring.test.ts");
    expect(output).toContain("fails when upstream adds or removes a literal");
    expect(output).toContain("src/primitives.test.ts");
    expect(output).toContain("refuses a fractional value");
  });

  // Este guard comprueba que el paquete que agregamos no rompe la suite de
  // contracts de UPSTREAM. Eso es lo que afirma, y nada más.
  //
  // ⚠ NO VOLVER A FIJAR EL CONTEO EXACTO. La primera versión afirmaba
  // `Tests 257 passed (257)`. El primer merge con upstream lo rompió: el commit
  // fe8750208 ("fix(contracts): reconcile provider default tests") agregó UN
  // test, la suite pasó 257 → 258, y este guard falló con todo en verde. La
  // igualdad no medía nuestra regresión, medía el ritmo de desarrollo de
  // upstream, que sube cada semana y no es asunto nuestro.
  //
  // El piso sí es nuestro. El riesgo real es que la suite se ENCOJA — que un
  // cambio del fork haga que dejen de recolectarse archivos, que es la forma en
  // que "todo verde" puede mentir. Un piso lo detecta y no le cobra nada a
  // upstream por crecer.
  const CONTRACT_SUITE_FLOOR = { files: 19, tests: 257 } as const;

  // ⚠ JSON, NUNCA la salida de texto del reporter. La segunda versión de este
  // guard leía `--reporter=dot` y buscaba `Test Files 19 passed (19)` con una
  // expresión regular. Pasaba en la laptop y fallaba en el runner de CI, con la
  // suite de contracts en verde en las dos: el subproceso salía con código 0,
  // imprimía sus puntos, y la cadena `Test Files` no aparecía NI UNA VEZ en el
  // log del worker.
  //
  // Nunca averigüé qué la sacaba, y esa es justamente la razón del cambio. Esa
  // línea es salida de PRESENTACIÓN: se mueve con la versión de vitest, con el
  // reporter, con si hay TTY, con el ancho de la terminal y con lo que sea que
  // haya hecho el runner. Un guard que exige entender el entorno para saber si
  // va a andar está midiendo el entorno, no el código.
  //
  // El reporter JSON sí es un contrato. `--outputFile` además evita depender de
  // que el resumen llegue por stdout, que es precisamente lo que se rompió.
  //
  // Tercera versión de este guard, y las tres fallas fueron la misma: atarse a
  // un valor que no nos pertenece. Primero el conteo exacto de upstream, después
  // el formato de salida de vitest. Lo que sí es nuestro es que la suite esté
  // verde y no se encoja.
  it("keeps upstream's contract suite green and not shrinking", () => {
    const reportPath = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "symmetria-contract-report-")),
      "report.json",
    );

    const result = run(
      vitePlusPath,
      ["test", "run", "--reporter=json", `--outputFile=${reportPath}`],
      NodePath.join(repositoryRoot, "packages/contracts"),
    );
    expectSuccessfulCommand(result);

    expect(NodeFS.existsSync(reportPath), commandOutput(result)).toBe(true);
    const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8")) as {
      readonly success: boolean;
      readonly numFailedTests: number;
      readonly numFailedTestSuites: number;
      readonly numPassedTests: number;
      readonly testResults: ReadonlyArray<unknown>;
    };

    // Verde: nada falló. Independiente de cuántos tests haya.
    expect(report.success).toBe(true);
    expect(report.numFailedTests).toBe(0);
    expect(report.numFailedTestSuites).toBe(0);

    // No se encogió. Upstream puede crecer libremente; encogerse en silencio no.
    expect(report.testResults.length).toBeGreaterThanOrEqual(CONTRACT_SUITE_FLOOR.files);
    expect(report.numPassedTests).toBeGreaterThanOrEqual(CONTRACT_SUITE_FLOOR.tests);
  }, 60_000);

  it("keeps every borrowed runtime vocabulary locked in both assignability directions", () => {
    expect(NodeFS.existsSync(NodePath.join(contractPackageRoot, "src/upstreamLock.ts"))).toBe(true);
    const temporaryDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "symmetria-upstream-lock-"),
    );
    try {
      const matchingResult = compileUpstreamLock(temporaryDirectory);
      expectSuccessfulCommand(matchingResult);

      for (const [name, canonicalValues] of Object.entries(BORROWED_RUNTIME_VOCABULARIES) as Array<
        [RuntimeVocabularyName, ReadonlyArray<string>]
      >) {
        const expandedResult = compileUpstreamLock(temporaryDirectory, {
          name,
          values: [...canonicalValues, "future_upstream_literal"],
        });
        expect(expandedResult.status, `${name} accepted an upstream addition`).not.toBe(0);

        const reducedResult = compileUpstreamLock(temporaryDirectory, {
          name,
          values: canonicalValues.slice(1),
        });
        expect(reducedResult.status, `${name} accepted an upstream removal`).not.toBe(0);
      }
    } finally {
      NodeFS.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 60_000);

  it("keeps exact and one-directional vocabulary locks distinct", () => {
    const temporaryDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "symmetria-lock-helper-"),
    );
    try {
      const fixturePath = NodePath.join(temporaryDirectory, "lock-helper.fixture.ts");
      const upstreamLockPath = NodePath.join(contractPackageRoot, "src/upstreamLock.ts");
      const upstreamLockImport = NodePath.relative(temporaryDirectory, upstreamLockPath);
      NodeFS.writeFileSync(
        fixturePath,
        [
          `import type { Covers, MutuallyAssignable } from ${JSON.stringify(upstreamLockImport)};`,
          'const exact: MutuallyAssignable<"active" | "unknown", "unknown" | "active"> = true;',
          'const widened: Covers<"active" | "unknown", "active"> = true;',
          "// @ts-expect-error an exact lock must reject a Symmetria-only fallback literal",
          'const exactAcceptedWidening: MutuallyAssignable<"active" | "unknown", "active"> = true;',
          "// @ts-expect-error a coverage lock must reject a missing upstream literal",
          'const coverageAcceptedNarrowing: Covers<"active", "active" | "idle"> = true;',
          "void exact;",
          "void widened;",
          "void exactAcceptedWidening;",
          "void coverageAcceptedNarrowing;",
        ].join("\n"),
      );
      const configPath = NodePath.join(temporaryDirectory, "tsconfig.json");
      NodeFS.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            extends: NodePath.join(repositoryRoot, "tsconfig.base.json"),
            compilerOptions: { noEmit: true },
            files: [fixturePath],
          },
          null,
          2,
        )}\n`,
      );
      expectSuccessfulCommand(run(typecheckerPath, ["-p", configPath]));
    } finally {
      NodeFS.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("keeps a stale vocabulary proof under an active @ts-expect-error", () => {
    const proofPath = NodePath.join(contractPackageRoot, "src/upstreamLock.test.ts");
    expect(NodeFS.existsSync(proofPath)).toBe(true);
    const source = NodeFS.readFileSync(proofPath, "utf8");
    expect(source).toContain("@ts-expect-error");
    expect(source).toMatch(/stale/i);
    expectSuccessfulCommand(run(typecheckerPath, ["--noEmit"], contractPackageRoot));
  });

  it("keeps the supported Symmetria protocol major version decodable", () => {
    const versionModulePath = NodePath.join(contractPackageRoot, "src/version.ts");
    expect(NodeFS.existsSync(versionModulePath)).toBe(true);
    const script = [
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaProtocolVersion } from "./src/version.ts";',
      "const result = Schema.decodeUnknownResult(SymmetriaProtocolVersion)({ major: 1, minor: 0 });",
      'if (result._tag !== "Success") throw new Error(String(result.failure));',
    ].join("\n");
    expectSuccessfulCommand(
      run(process.execPath, ["--input-type=module", "--eval", script], contractPackageRoot),
    );
  });

  it("keeps a typed decode failure for an unsupported protocol major version", () => {
    const versionModulePath = NodePath.join(contractPackageRoot, "src/version.ts");
    expect(NodeFS.existsSync(versionModulePath)).toBe(true);
    const script = [
      'import * as Schema from "effect/Schema";',
      'import { decodeSymmetriaProtocolVersion, SymmetriaProtocolVersion } from "./src/version.ts";',
      "const schemaResult = Schema.decodeUnknownResult(SymmetriaProtocolVersion)({ major: 2, minor: 0 });",
      'if (schemaResult._tag !== "Failure") throw new Error("unsupported major decoded successfully");',
      "const result = decodeSymmetriaProtocolVersion({ major: 2, minor: 0 });",
      'if (result._tag !== "Failure") throw new Error("unsupported major passed the version gate");',
      'if (result.failure._tag !== "SymmetriaProtocolVersionMismatch") throw new Error("wrong rejection tag");',
      'if (result.failure.supportedMajor !== 1) throw new Error("wrong supported major");',
      'if (result.failure.receivedMajor !== 2) throw new Error("wrong received major");',
    ].join("\n");
    expectSuccessfulCommand(
      run(process.execPath, ["--input-type=module", "--eval", script], contractPackageRoot),
    );
  });

  it("keeps the public entry point composed from upstream schema values", () => {
    const script = [
      'import * as Schema from "effect/Schema";',
      'import * as BrokerContract from "@symmetria/broker-contract";',
      'import * as UpstreamContract from "@t3tools/contracts";',
      "const sharedSchemas = ['CommandId', 'EnvironmentId', 'ProjectId', 'ThreadId', 'TurnId'];",
      "for (const name of sharedSchemas) {",
      "  if (BrokerContract[name] !== UpstreamContract[name]) {",
      "    throw new Error(`${name} is not the upstream schema value`);",
      "  }",
      "}",
      "if ('RuntimeTurnState' in BrokerContract.BORROWED_RUNTIME_VOCABULARIES) {",
      '  throw new Error("RuntimeTurnState was copied instead of composed from ProviderRuntimeTurnStatus");',
      "}",
      "const turnStateSchema = Schema.toJsonSchemaDocument(UpstreamContract.ProviderRuntimeTurnStatus).schema;",
      "if (!Array.isArray(turnStateSchema.enum) || turnStateSchema.enum.length === 0) {",
      '  throw new Error("ProviderRuntimeTurnStatus is not usable as the upstream schema value");',
      "}",
    ].join("\n");
    expectSuccessfulCommand(
      run(process.execPath, ["--input-type=module", "--eval", script], contractPackageRoot),
    );
  });

  it("keeps every non-negative field aligned in generated JSON Schema", () => {
    const script = [
      'import * as Schema from "effect/Schema";',
      'import { AnnouncedProtocolVersion, NonNegativeInteger, SymmetriaDraftVersion, SymmetriaProtocolVersion, SymmetriaSnapshotRevision } from "@symmetria/broker-contract";',
      "const schemaOf = (schema) => {",
      "  const document = Schema.toJsonSchemaDocument(schema);",
      "  const reference = document.schema.$ref;",
      "  if (typeof reference !== 'string') return document.schema;",
      "  const prefix = '#/$defs/';",
      "  if (!reference.startsWith(prefix)) throw new Error(`external schema reference: ${reference}`);",
      "  const resolved = document.definitions?.[reference.slice(prefix.length)];",
      "  if (resolved === undefined) throw new Error(`unresolved schema reference: ${reference}`);",
      "  return resolved;",
      "};",
      "console.log(JSON.stringify({",
      "  base: schemaOf(NonNegativeInteger),",
      "  draftVersion: schemaOf(SymmetriaDraftVersion),",
      "  snapshotRevision: schemaOf(SymmetriaSnapshotRevision),",
      "  announcedVersion: schemaOf(AnnouncedProtocolVersion),",
      "  supportedVersion: schemaOf(SymmetriaProtocolVersion),",
      "}));",
    ].join("\n");
    const result = run(
      process.execPath,
      ["--input-type=module", "--eval", script],
      contractPackageRoot,
    );
    expectSuccessfulCommand(result);
    const documents = JSON.parse(result.stdout) as {
      readonly base: unknown;
      readonly draftVersion: unknown;
      readonly snapshotRevision: unknown;
      readonly announcedVersion: {
        readonly properties: { readonly major: unknown; readonly minor: unknown };
      };
      readonly supportedVersion: {
        readonly properties: { readonly minor: unknown };
      };
    };

    // Effect 4.0.0-rc.112 emits the bound directly; up to beta.103 it wrapped
    // it in `allOf: [{ minimum: 0 }]`. What this guard is for is the alignment
    // below — every non-negative field carrying the SAME constraint — so the
    // shape is pinned only to catch the day one of them stops matching.
    expect(documents.base).toEqual({
      type: "integer",
      minimum: 0,
    });
    expect(documents.draftVersion).toEqual(documents.base);
    expect(documents.snapshotRevision).toEqual(documents.base);
    expect(documents.announcedVersion.properties.major).toEqual(documents.base);
    expect(documents.announcedVersion.properties.minor).toEqual(documents.base);
    expect(documents.supportedVersion.properties.minor).toEqual(documents.base);
  });

  it("keeps a pnpm lockfile importer aligned with the Symmetria package manifest", () => {
    const packageManifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(contractPackageRoot, "package.json"), "utf8"),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const workspaceSource = NodeFS.readFileSync(
      NodePath.join(repositoryRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    const lockfileSource = NodeFS.readFileSync(
      NodePath.join(repositoryRoot, "pnpm-lock.yaml"),
      "utf8",
    );
    const importerMatch = lockfileSource.match(
      /^  packages\/symmetria-broker-contract:\n(?<body>(?: {4,}.*\n|\n)*)/m,
    );
    expect(lockfileSource.match(/^  packages\/symmetria-broker-contract:$/gm)).toHaveLength(1);
    expect(importerMatch?.groups?.body).toBeDefined();
    const importerBody = importerMatch?.groups?.body ?? "";

    const expectedSections = {
      dependencies: packageManifest.dependencies,
      devDependencies: packageManifest.devDependencies,
    } as const;
    for (const [sectionName, dependencies] of Object.entries(expectedSections)) {
      const sectionMatch = importerBody.match(
        new RegExp(`^    ${sectionName}:\\n(?<body>(?: {6,}.*\\n|\\n)*)`, "m"),
      );
      expect(sectionMatch?.groups?.body, `missing ${sectionName}`).toBeDefined();
      const sectionBody = sectionMatch?.groups?.body ?? "";
      const lockedNames = [...sectionBody.matchAll(/^      ['"]?([^'":]+)['"]?:$/gm)].map(
        ([, name]) => name,
      );
      expect(lockedNames.sort()).toEqual(Object.keys(dependencies).sort());

      for (const [dependencyName, manifestSpecifier] of Object.entries(dependencies)) {
        const escapedName = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const dependencyMatch = sectionBody.match(
          new RegExp(`^      ['"]?${escapedName}['"]?:\\n        specifier: (.+)$`, "m"),
        );
        expect(dependencyMatch?.[1], `missing ${dependencyName}`).toBeDefined();
        const catalogMatch = manifestSpecifier.match(/^catalog:(.*)$/);
        const catalogName = catalogMatch?.[1] || dependencyName;
        const escapedCatalogName = catalogName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const catalogSpecifier = workspaceSource.match(
          new RegExp(`^  ["']?${escapedCatalogName}["']?: (.+)$`, "m"),
        )?.[1];
        const lockedSpecifier = dependencyMatch?.[1]?.replace(/^['"]|['"]$/g, "");
        if (catalogMatch) {
          expect([manifestSpecifier, catalogSpecifier]).toContain(lockedSpecifier);
        } else {
          expect(lockedSpecifier).toBe(manifestSpecifier);
        }
      }
    }
  });

  // NO REPONER: acá vivía "keeps unrelated registry metadata out of the
  // phase-one lockfile change", que leía pnpm-lock.yaml y exigía que los bloques
  // de @xmldom/xmldom no tuvieran una línea `deprecated:`.
  //
  // Era imposible de pasar por construcción. pnpm reescribe esa metadata cada vez
  // que resuelve contra el registro, y eso ocurre en la cadena `prepare` de la
  // raíz — que dispara el propio `pnpm test`. Medido el 2026-08-20: el lockfile
  // pasaba de 25 a 27 inserciones durante la misma corrida que lo verificaba, así
  // que ejecutar el test era lo que lo rompía.
  //
  // La premisa también era equivocada. Esas líneas no son contaminación: son
  // hechos del registro que pnpm mantiene al día. Se las trató como basura porque
  // aparecieron por primera vez en un diff junto a un cambio ajeno, y de ahí salió
  // un guardián permanente contra el comportamiento normal de la herramienta.
  //
  // Si alguna vez hace falta proteger el lockfile, hay que afirmar sobre el diff
  // COMMITEADO, no sobre el árbol de trabajo que las herramientas del proyecto
  // reescriben mientras el test corre.
});
