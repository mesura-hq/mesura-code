pragma Singleton

import Symmetria.FileManager.Models
import QtQuick

QtObject {
    readonly property string home: Env.get("HOME")
    readonly property string _homeSlash: home + "/"

    function shortenHomeBare(path: string): string {
        if (path === home)
            return "~";
        if (path.startsWith(_homeSlash))
            return path.slice(_homeSlash.length);
        return path;
    }

    function shortenHome(path: string): string {
        if (path === home)
            return "~";
        if (path.startsWith(_homeSlash))
            return "~/" + path.slice(_homeSlash.length);
        return path;
    }

    function basename(path: string): string {
        return path.substring(path.lastIndexOf("/") + 1);
    }

    function parentDir(path: string): string {
        return path.replace(/\/[^/]+$/, "") || "/";
    }
}
