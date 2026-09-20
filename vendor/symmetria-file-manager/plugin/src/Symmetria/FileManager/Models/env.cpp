#include "env.hpp"

#include <qprocess.h>

namespace symmetria::filemanager::models {

Env::Env(QObject* parent)
    : QObject(parent)
{
}

QString Env::get(const QString& name, const QString& defaultValue) const
{
    const QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    if (!env.contains(name))
        return defaultValue;
    return env.value(name);
}

bool Env::has(const QString& name) const
{
    return QProcessEnvironment::systemEnvironment().contains(name);
}

} // namespace symmetria::filemanager::models
