import QtQuick

QtObject {
    id: root

    // Set by the owning FileManager — the first tab starts here
    property string initialPath

    // === Tab collection ===
    property var tabs: []
    property int activeIndex: 0

    readonly property WindowState activeTab: tabs.length > 0 ? tabs[activeIndex] : null
    readonly property int count: tabs.length
    readonly property bool showBar: count > 1

    // Emitted BEFORE activeIndex changes — listeners should save cursor state
    signal aboutToSwitchTab()

    // Internal component for stamping out WindowState instances
    property Component _windowStateComponent: Component {
        WindowState {}
    }

    Component.onCompleted: {
        Logger.info("TabManager", "init with path: " + initialPath);
        createTab(initialPath);
    }

    function createTab(tabInitialPath: string): void {
        const state = _windowStateComponent.createObject(root, {
            "initialPath": tabInitialPath || initialPath,
            "currentPath": tabInitialPath || initialPath
        });

        if (!state) {
            Logger.error("TabManager", "failed to create WindowState");
            return;
        }

        const newTabs = tabs.slice();
        // Insert new tab right after the active one
        const insertIndex = tabs.length > 0 ? activeIndex + 1 : 0;
        newTabs.splice(insertIndex, 0, state);
        tabs = newTabs;

        // Save cursor state on the departing tab before switching
        if (count > 1)
            aboutToSwitchTab();
        activeIndex = insertIndex;
        Logger.debug("TabManager", "createTab → count=" + count + " activeIndex=" + activeIndex + " showBar=" + showBar + " path=" + (tabInitialPath || initialPath));
    }

    function closeTab(index: int): bool {
        if (index < 0 || index >= count)
            return true; // nothing to close, but don't signal "last tab"

        const closing = tabs[index];
        const newTabs = tabs.slice();
        newTabs.splice(index, 1);

        if (newTabs.length === 0) {
            // Last tab — caller should close the window
            // Clear tabs first so activeTab binding resolves to null before the object is freed
            tabs = [];
            closing.destroy();
            return false;
        }

        // Adjust activeIndex before reassigning tabs
        let newIndex = activeIndex;
        if (index < activeIndex) {
            newIndex--;
        } else if (index === activeIndex) {
            // Closing active tab: prefer moving to the left tab, or stay at 0
            newIndex = Math.min(index, newTabs.length - 1);
            // Notify listeners (e.g. FileList) to save cursor before we switch away
            aboutToSwitchTab();
        }

        // Assign activeIndex before tabs so the activeTab binding never points at the
        // spliced-out slot while tabs already reflects the post-close array.
        activeIndex = newIndex;
        tabs = newTabs;
        closing.destroy();
        return true;
    }

    function activateTab(index: int): void {
        if (index < 0 || index >= count || index === activeIndex)
            return;

        // Block tab switch if a modal is active on the current tab
        if (_hasActiveModal())
            return;

        aboutToSwitchTab();
        activeIndex = index;
        Logger.debug("TabManager", "activateTab → index=" + index);
    }

    function nextTab(): void {
        if (count <= 1)
            return;
        activateTab((activeIndex + 1) % count);
    }

    function prevTab(): void {
        if (count <= 1)
            return;
        activateTab((activeIndex - 1 + count) % count);
    }

    // Check if the active tab has any open modal/dialog.
    // Zoxide is deliberately excluded — tab switching is allowed while zoxide is open.
    function _hasActiveModal(): bool {
        if (!activeTab)
            return false;
        const m = activeTab.activeModal;
        return m !== activeTab.modalNone && m !== activeTab.modalZoxide;
    }
}
