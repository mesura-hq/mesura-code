#pragma once

#include <qstring.h>

namespace symmetria::filemanager::models {

// Extracts the largest PNG image from an Apple .icns container file.
// Returns cachePath on success, empty string on failure.
// Designed to run off the main thread (called from QtConcurrent::run).
namespace IcnsDecoder {
    QString extractLargestPng(const QString& sourcePath, const QString& cachePath);
} // namespace IcnsDecoder

} // namespace symmetria::filemanager::models
