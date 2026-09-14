#pragma once

// Env — QML singleton for environment variable access.
//
// Replaces Quickshell.env(name) for callsites like `Quickshell.env("HOME")`
// in services/Paths.qml. Exposed as a QML singleton:
//
//   import Symmetria.FileManager.Models
//   Item { property string home: Env.get("HOME") }

#include <qobject.h>
#include <qqmlintegration.h>
#include <qstring.h>

namespace symmetria::filemanager::models {

class Env : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

public:
    explicit Env(QObject* parent = nullptr);

    Q_INVOKABLE QString get(const QString& name, const QString& defaultValue = QString()) const;
    Q_INVOKABLE bool has(const QString& name) const;
};

} // namespace symmetria::filemanager::models
