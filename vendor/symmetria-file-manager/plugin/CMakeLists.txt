cmake_minimum_required(VERSION 3.19)
project(symmetria-filemanager-plugin VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
    set(CMAKE_INSTALL_PREFIX "/usr" CACHE PATH "Install prefix" FORCE)
endif()

set(INSTALL_QMLDIR "lib/qt6/qml" CACHE STRING "QML module install directory (relative to CMAKE_INSTALL_PREFIX)")

# GuiPrivate needed because QXlsx links against Qt6::GuiPrivate
find_package(Qt6 REQUIRED COMPONENTS Core Qml Gui Concurrent GuiPrivate Multimedia)
find_package(KF6SyntaxHighlighting REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(LibArchive IMPORTED_TARGET libarchive REQUIRED)
find_package(QXlsxQt6 REQUIRED)
pkg_check_modules(FreeXL IMPORTED_TARGET freexl REQUIRED)
pkg_check_modules(Libheif IMPORTED_TARGET libheif REQUIRED)

# === Rust file-search engine (fff) via Corrosion ===
# The fuzzy finder's backend is the MIT-licensed `fff` engine, vendored as a
# submodule under third_party/fff and consumed through its `fff-c` C ABI
# (header: third_party/fff/crates/fff-c/include/fff.h, cbindgen-generated).
# Corrosion drives cargo from CMake so `cmake --build` builds libfff_c.so
# alongside the C++ sources. We import ONLY the fff-c crate (CRATES fff-c) so
# the workspace's Lua/MCP members are never built. PROFILE release is forced:
# a debug build of the SIMD matcher would defeat the reason we adopted it.
include(FetchContent)
FetchContent_Declare(Corrosion
    GIT_REPOSITORY https://github.com/corrosion-rs/corrosion.git
    GIT_TAG v0.6.1
)
FetchContent_MakeAvailable(Corrosion)

corrosion_import_crate(
    MANIFEST_PATH "${CMAKE_CURRENT_LIST_DIR}/third_party/fff/Cargo.toml"
    CRATES fff-c
    PROFILE release
)

set(QT_QML_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/qml")
qt_standard_project_setup(REQUIRES 6.9)

add_compile_options(
    -Wall -Wextra -Wpedantic -Wshadow -Wconversion
    -Wold-style-cast -Wnull-dereference -Wdouble-promotion
    -Wformat=2 -Wfloat-equal -Woverloaded-virtual
    -Wsign-conversion -Wredundant-decls -Wswitch
    -Wunreachable-code
)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    add_compile_options(-Wunused-lambda-capture)
endif()

add_subdirectory(src/Symmetria/FileManager/Models)

option(BUILD_TESTING "Build unit tests" ON)
if(BUILD_TESTING)
    enable_testing()
    add_subdirectory(tests)
endif()

# === Install the panel QML as Symmetria.FileManager.UI ===
# The panel files live at <project>/qml/Symmetria/FileManager/UI/. Their
# directory layout already mirrors the Qt QML module convention, so a
# direct copy to the system import path makes `import Symmetria.FileManager.UI`
# resolve from any Qt6 process. The C++ plugin (Symmetria.FileManager.Models)
# installed by add_subdirectory above lives as a sibling under
# Symmetria/FileManager/Models/ — same prefix, different leaf.
set(UI_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}/../qml/Symmetria/FileManager/UI")
set(UI_INSTALL_DIR "${INSTALL_QMLDIR}/Symmetria/FileManager/UI")

install(DIRECTORY "${UI_SOURCE_DIR}/"
    DESTINATION "${UI_INSTALL_DIR}"
    COMPONENT runtime
    FILES_MATCHING
        PATTERN "qmldir"
        PATTERN "*.qml"
        PATTERN "*.js"
)

# Clear Quickshell QML cache after install
install(CODE "
    if(DEFINED ENV{SUDO_USER})
        set(_user_home \"/home/\$ENV{SUDO_USER}\")
    else()
        set(_user_home \"\$ENV{HOME}\")
    endif()
    set(_qmlcache_dir \"\${_user_home}/.cache/quickshell/qmlcache\")
    if(EXISTS \"\${_qmlcache_dir}\")
        message(STATUS \"Clearing Quickshell QML cache: \${_qmlcache_dir}\")
        file(REMOVE_RECURSE \"\${_qmlcache_dir}\")
    endif()
")
