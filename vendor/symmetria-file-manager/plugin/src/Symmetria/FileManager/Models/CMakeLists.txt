qt_add_qml_module(symmetria-filemanager-models
    URI Symmetria.FileManager.Models
    VERSION ${PROJECT_VERSION}
    SOURCES
        filesystemmodel.hpp filesystemmodel.cpp
        fileinfo.hpp fileinfo.cpp
        iconthemeresolver.hpp iconthemeresolver.cpp
        appiconprovider.hpp appiconprovider.cpp
        previewimagehelper.hpp previewimagehelper.cpp
        icnsdecoder.hpp icnsdecoder.cpp
        heifdecoder.hpp heifdecoder.cpp
        syntaxhighlighthelper.hpp syntaxhighlighthelper.cpp
        archivepreviewmodel.hpp archivepreviewmodel.cpp
        spreadsheetpreviewmodel.hpp spreadsheetpreviewmodel.cpp
        audiowaveformmodel.hpp audiowaveformmodel.cpp
        fuzzyfinder.hpp fuzzyfinder.cpp
        shellrunner.hpp shellrunner.cpp
        filewatcher.hpp filewatcher.cpp
        env.hpp env.cpp
)

target_link_libraries(symmetria-filemanager-models PRIVATE
    Qt::Core Qt::Qml Qt::Gui Qt::Concurrent Qt::Multimedia
    KF6::SyntaxHighlighting
    PkgConfig::LibArchive
    QXlsx::QXlsx
    PkgConfig::FreeXL
    PkgConfig::Libheif
    # Corrosion normalizes the crate target name `fff-c` -> `fff_c` (hyphens to
    # underscores); the CRATES filter in the top CMakeLists still uses `fff-c`.
    fff_c
)

# fff-c's cbindgen-generated C ABI header (FffCreateOptions, fff_search_mixed, ...)
target_include_directories(symmetria-filemanager-models PRIVATE
    "${CMAKE_SOURCE_DIR}/third_party/fff/crates/fff-c/include"
)

# Embed the "Wine" syntax-highlighting theme (mirrors the user's NeoVim Lush
# colorscheme) directly into the plugin .so as a Qt resource. SyntaxHighlightHelper
# registers ":/symmetria-fm-syntax" as a KSyntaxHighlighting custom search path,
# which scans the "themes/" subfolder beneath it — hence the resource path
# ":/symmetria-fm-syntax/themes/wine.theme". Embedding (vs installing to an XDG
# data dir) means every consumer of this plugin inherits the theme with no
# install-path coordination, mirroring how KF6 ships its own built-in themes.
qt_add_resources(symmetria-filemanager-models "syntax_themes"
    PREFIX "/symmetria-fm-syntax"
    FILES themes/wine.theme
)

# libfff_c.so is co-installed next to this module (see install rule below), so
# the loader must look beside the library. Without this, EVERY consumer of the
# plugin (the FM, Symmetria Shell's wallpaper picker/file dialog, Symmetria-IDE)
# would fail to load the whole module when libfff_c.so isn't on the default path.
set_target_properties(symmetria-filemanager-models PROPERTIES
    INSTALL_RPATH "$ORIGIN"
)

# Install module to QML import path
qt_query_qml_module(symmetria-filemanager-models
    PLUGIN_TARGET module_plugin_target
    TARGET_PATH module_target_path
    QMLDIR module_qmldir
    TYPEINFO module_typeinfo
)

set(module_dir "${INSTALL_QMLDIR}/${module_target_path}")
install(TARGETS symmetria-filemanager-models LIBRARY DESTINATION "${module_dir}" RUNTIME DESTINATION "${module_dir}" COMPONENT runtime)
install(TARGETS "${module_plugin_target}" LIBRARY DESTINATION "${module_dir}" RUNTIME DESTINATION "${module_dir}" COMPONENT runtime)
install(FILES "${module_qmldir}" DESTINATION "${module_dir}" COMPONENT runtime)
install(FILES "${module_typeinfo}" DESTINATION "${module_dir}" COMPONENT dev)

# Ship the Rust engine's shared object beside the plugin so $ORIGIN rpath resolves it.
# Corrosion's target is an INTERFACE proxy (no TARGET_FILE), so install via its
# dedicated helper rather than install(FILES ...).
corrosion_install(TARGETS fff_c LIBRARY DESTINATION "${module_dir}" COMPONENT runtime)
