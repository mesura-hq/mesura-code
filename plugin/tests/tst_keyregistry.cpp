// Qt Quick Test entry point for the KeyRegistry.js keybinding-registry tests.
// The actual assertions live in tst_keyregistry.qml (loaded from the source dir
// via the -input argument set in CMakeLists.txt). Qt Quick Test needs a
// QGuiApplication, so the test runs under QT_QPA_PLATFORM=offscreen in CI.
#include <QtQuickTest/quicktest.h>

QUICK_TEST_MAIN(keyregistry)
