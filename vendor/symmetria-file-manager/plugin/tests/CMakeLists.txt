include(CTest)

find_package(Qt6 REQUIRED COMPONENTS Test Core Concurrent Gui Qml)
find_package(KF6SyntaxHighlighting REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(LibArchive IMPORTED_TARGET libarchive REQUIRED)

set(MODELS_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../src/Symmetria/FileManager/Models")

function(add_model_test TEST_NAME)
    add_executable(${TEST_NAME} ${TEST_NAME}.cpp)
    target_include_directories(${TEST_NAME} PRIVATE ${MODELS_SRC_DIR})
    target_link_libraries(${TEST_NAME} PRIVATE
        Qt6::Test
        Qt6::Core
        Qt6::Gui
        Qt6::Qml
        symmetria-filemanager-models
    )
    add_test(NAME ${TEST_NAME} COMMAND ${TEST_NAME})
    # QTextDocument and QImageReader require QGuiApplication; offscreen avoids
    # needing a display server in CI or headless environments.
    set_tests_properties(${TEST_NAME} PROPERTIES
        ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
        TIMEOUT 60
    )
endfunction()

add_model_test(FileSystemModelTest)
target_link_libraries(FileSystemModelTest PRIVATE Qt6::Concurrent)

add_model_test(ArchivePreviewModelTest)
target_link_libraries(ArchivePreviewModelTest PRIVATE PkgConfig::LibArchive)

add_model_test(SyntaxHighlightHelperTest)
target_link_libraries(SyntaxHighlightHelperTest PRIVATE KF6::SyntaxHighlighting)

add_model_test(FuzzyFinderTest)
target_link_libraries(FuzzyFinderTest PRIVATE Qt6::Concurrent)

add_model_test(FileInfoTest)
target_link_libraries(FileInfoTest PRIVATE Qt6::Concurrent)

add_model_test(PreviewImageHelperTest)
target_link_libraries(PreviewImageHelperTest PRIVATE Qt6::Concurrent)

add_model_test(HeifDecoderTest)
# HeifDecoder::decodeToPng lives in the model lib (which links libheif privately),
# so the test needs no direct libheif link. The fixture dir is baked in as a
# compile define so the test finds sample.heic without a working-directory guess.
target_compile_definitions(HeifDecoderTest PRIVATE
    HEIF_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures"
)

add_model_test(AppIconProviderTest)

add_model_test(ShellRunnerTest)

add_model_test(FileWatcherTest)

add_model_test(EnvTest)

# --- QML keybinding-registry test (Qt Quick Test) ---------------------------
# Unlike the C++ model tests above, this exercises KeyRegistry.js directly via a
# QML TestCase. The registry takes its singletons through ctx.services (DI), so
# the test imports ONLY the .js + QtQuick and drives it with stubs — no UI module
# load. The QML lives in the repo source tree, found via the -input argument.
find_package(Qt6 REQUIRED COMPONENTS QuickTest)
add_executable(KeyRegistryTest tst_keyregistry.cpp)
target_link_libraries(KeyRegistryTest PRIVATE
    Qt6::QuickTest
    Qt6::Qml
    Qt6::Gui
)
# -input points at the specific .qml file (not the dir): Qt Quick Test scans a
# directory recursively, so a bare dir would make every QML-test executable run
# every tst_*.qml here. Scoping each to its file keeps the executables disjoint.
add_test(NAME KeyRegistryTest
    COMMAND KeyRegistryTest -input "${CMAKE_CURRENT_SOURCE_DIR}/tst_keyregistry.qml"
)
# Qt Quick Test needs a QGuiApplication; offscreen keeps it headless in CI.
set_tests_properties(KeyRegistryTest PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
    TIMEOUT 60
)

# --- QML image-chord gate test (Qt Quick Test) ------------------------------
# Same hermetic pattern as KeyRegistryTest: imports ImageChord.js + QtQuick/QtTest
# only, never the UI module, so it runs in CI where the UI module isn't installed.
add_executable(ChordBindingsTest tst_chordbindings.cpp)
target_link_libraries(ChordBindingsTest PRIVATE
    Qt6::QuickTest
    Qt6::Qml
    Qt6::Gui
)
add_test(NAME ChordBindingsTest
    COMMAND ChordBindingsTest -input "${CMAKE_CURRENT_SOURCE_DIR}/tst_chordbindings.qml"
)
set_tests_properties(ChordBindingsTest PROPERTIES
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
    TIMEOUT 60
)
