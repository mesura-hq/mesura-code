#pragma once

#include <qstring.h>

namespace symmetria::filemanager::models {

// Decodes the primary image of a HEIF/HEIC container (.heic/.heif) to a PNG.
// Qt has no native HEIF image plugin on our target (Arch's qt6-imageformats is
// built without libheif), so — like .icns — HEIC cannot be handed straight to a
// QML Image and must be decoded here via libheif and cached as PNG.
//
// Returns cachePath on success, empty string on failure.
// Designed to run off the main thread (called from QtConcurrent::run).
namespace HeifDecoder {
    QString decodeToPng(const QString& sourcePath, const QString& cachePath);
} // namespace HeifDecoder

} // namespace symmetria::filemanager::models
