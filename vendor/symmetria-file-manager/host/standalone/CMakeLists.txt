cmake_minimum_required(VERSION 3.19)
project(symmetria-fm-host VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
    set(CMAKE_INSTALL_PREFIX "/usr" CACHE PATH "Install prefix" FORCE)
endif()

# WebEngineQuick powers the HTML render preview (Ctrl+R). It must be linked so
# QtWebEngineQuick::initialize() is available in main(); the QML `import
# QtWebEngine` resolves from Qt's default module path at runtime.
find_package(Qt6 REQUIRED COMPONENTS Core Gui Qml Quick Network WebEngineQuick)

# Path containing Symmetria/FileManager/UI/qmldir — passed to engine
# .addImportPath() at startup. In dev this points at the source tree's
# qml/ subdir; after install the binary will additionally find
# /usr/lib/qt6/qml on its own (Qt's default QML import path).
set(SYMMETRIA_FM_PANEL_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../../qml"
    CACHE PATH "Path to the panel QML import root (containing Symmetria/...)")
set(SYMMETRIA_FM_QML_PATH "${CMAKE_CURRENT_SOURCE_DIR}/main.qml"
    CACHE PATH "Path to the host main.qml")

qt_standard_project_setup(REQUIRES 6.9)

# === symmetria-fm — the daemon binary ===
qt_add_executable(symmetria-fm
    main.cpp
    server.hpp
    server.cpp
)

target_link_libraries(symmetria-fm PRIVATE
    Qt::Core Qt::Gui Qt::Qml Qt::Quick Qt::Network Qt::WebEngineQuick
)

target_compile_definitions(symmetria-fm PRIVATE
    SYMMETRIA_FM_PANEL_PATH="${SYMMETRIA_FM_PANEL_PATH}"
    SYMMETRIA_FM_QML_PATH="${SYMMETRIA_FM_QML_PATH}"
)

install(TARGETS symmetria-fm RUNTIME DESTINATION bin)

# The .desktop entry and its icon ship with the binary, not with the portal
# backend: main.cpp calls setDesktopFileName("symmetria-fm") and Qt6 registers
# that id with org.freedesktop.portal.Registry on every startup. If no XDG
# applications dir holds a matching file the portal answers "App info not found
# for ''" and the FM's own portal requests stay anonymous.
#
# This is the ONLY place either file is installed, and both go to the system
# prefix. install.sh used to copy them into ~/.local/share instead; since the
# user scope takes XDG precedence over /usr, that copy shadowed this one and
# went stale on every rebuild. The icon has to follow the .desktop into the same
# scope — leaving it user-scope would make Icon=symmetria-fm resolve only for
# whoever ran install.sh and silently degrade to a generic glyph for everyone
# else.
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../../symmetria-fm.desktop"
        DESTINATION share/applications)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../../assets/symmetria-fm.png"
        DESTINATION share/icons/hicolor/512x512/apps)

# === symmetria-fm-cli — the CLI sender ===
qt_add_executable(symmetria-fm-cli
    cli.cpp
)

target_link_libraries(symmetria-fm-cli PRIVATE
    Qt::Core Qt::Network
)

install(TARGETS symmetria-fm-cli RUNTIME DESTINATION bin)
