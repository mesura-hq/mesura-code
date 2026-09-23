import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// Exercise the installed dependency's patched search without Gradle, an NDK,
// or host libraries. A competing host search path reproduces the Linux failure.
const hasCmake = NodeChildProcess.spawnSync("cmake", ["--version"]).status === 0;

it.skipIf(!hasCmake)(
  "mobile phase3 native regression selects only bundled ABI oniguruma libraries",
  () => {
    const source = NodeFS.readFileSync(
      new URL(
        "../../node_modules/react-native-shiki-engine/android/CMakeLists.txt",
        import.meta.url,
      ),
      "utf8",
    );
    const search = source.match(/find_library\(ONIG_LIB[\s\S]*?\n\)/)?.[0];
    expect(search).toBeDefined();
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-onig-regression-"));
    const cmakePath = (path: string) => path.replaceAll("\\", "/");
    try {
      const host = NodePath.join(directory, "host");
      NodeFS.mkdirSync(host);
      NodeFS.writeFileSync(NodePath.join(host, "libonig.so"), "competing host library");
      for (const abi of ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]) {
        const bundled = NodePath.join(directory, "src/main/jniLibs", abi);
        NodeFS.mkdirSync(bundled, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(bundled, "libonig.so"), "Android ABI library");
      }
      for (const abi of ["arm64-v8a", "armeabi-v7a", "x86", "x86_64", "missing-abi"]) {
        const script = NodePath.join(directory, "probe.cmake");
        NodeFS.writeFileSync(
          script,
          `
set(CMAKE_CURRENT_SOURCE_DIR "${cmakePath(directory)}")
set(ANDROID_ABI "${abi}")
set(CMAKE_LIBRARY_PATH "${cmakePath(host)}")
set(CMAKE_FIND_LIBRARY_PREFIXES "lib")
set(CMAKE_FIND_LIBRARY_SUFFIXES ".so")
${search}
if(NOT ONIG_LIB STREQUAL "${cmakePath(directory)}/src/main/jniLibs/${abi}/libonig.so")
  message(FATAL_ERROR "Selected a non-Android library: \${ONIG_LIB}")
endif()
`,
        );
        const result = NodeChildProcess.spawnSync("cmake", ["-P", script], { encoding: "utf8" });
        if (abi === "missing-abi") {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("Could not find ONIG_LIB");
        } else {
          expect(result.status, result.stderr).toBe(0);
        }
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
