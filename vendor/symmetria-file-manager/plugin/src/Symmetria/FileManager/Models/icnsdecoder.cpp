#include "icnsdecoder.hpp"

#include <qdir.h>
#include <qendian.h>
#include <qfile.h>
#include <qfileinfo.h>

#include <array>

namespace symmetria::filemanager::models {

// Modern .icns chunk types that contain PNG data, ordered by resolution priority
// (highest first). Each tag is a 4-byte ASCII identifier stored big-endian.
//
//   ic10 = 1024x1024    ic14 = 512x512@2x   ic09 = 512x512
//   ic13 = 256x256@2x   ic08 = 256x256       ic12 = 64x64@2x
//   ic07 = 128x128      ic11 = 32x32@2x
static constexpr std::array<quint32, 8> kPngChunkTypes = {
    0x69633130, // ic10
    0x69633134, // ic14
    0x69633039, // ic09
    0x69633133, // ic13
    0x69633038, // ic08
    0x69633132, // ic12
    0x69633037, // ic07
    0x69633131, // ic11
};

static int chunkPriority(quint32 tag) {
    for (size_t i = 0; i < kPngChunkTypes.size(); ++i) {
        if (kPngChunkTypes[i] == tag) return static_cast<int>(i);
    }
    return -1;
}

namespace IcnsDecoder {

QString extractLargestPng(const QString& sourcePath, const QString& cachePath) {
    QFile file(sourcePath);
    if (!file.open(QIODevice::ReadOnly))
        return {};

    const qint64 fileSize = file.size();
    if (fileSize < 8)
        return {};

    // Read and validate header: 4-byte magic "icns" + 4-byte total size (big-endian)
    const QByteArray header = file.read(8);
    if (header.size() < 8)
        return {};

    if (!header.startsWith("icns"))
        return {};

    const auto totalSize = static_cast<qint64>(qFromBigEndian<quint32>(header.constData() + 4));

    // Use the smaller of declared size and actual file size to handle truncation
    const qint64 endOffset = qMin(totalSize, fileSize);

    // Iterate chunks and find the best PNG-containing one
    int bestPriority = static_cast<int>(kPngChunkTypes.size()); // lower is better
    qint64 bestDataOffset = -1;
    quint32 bestDataSize = 0;

    qint64 offset = 8;
    while (offset + 8 <= endOffset) {
        file.seek(offset);
        const QByteArray chunkHeader = file.read(8);
        if (chunkHeader.size() < 8)
            break;

        const auto tag       = qFromBigEndian<quint32>(chunkHeader.constData());
        const auto chunkSize = static_cast<qint64>(qFromBigEndian<quint32>(chunkHeader.constData() + 4));

        // Chunk size includes the 8-byte header; must be at least 8.
        // Use continue (not break) so a single malformed chunk doesn't abort
        // scanning — subsequent chunks may still be valid.
        if (chunkSize < 8 || offset + chunkSize > endOffset) {
            if (chunkSize == 0) break; // zero-size would loop forever
            continue;
        }

        const int priority = chunkPriority(tag);
        if (priority >= 0 && priority < bestPriority) {
            bestPriority = priority;
            bestDataOffset = offset + 8;
            bestDataSize = static_cast<quint32>(chunkSize - 8);

            // Can't do better than priority 0
            if (priority == 0) break;
        }

        offset += chunkSize;
    }

    if (bestDataOffset < 0 || bestDataSize == 0)
        return {};

    // Read the PNG data and validate magic bytes
    file.seek(bestDataOffset);
    const QByteArray pngData = file.read(bestDataSize);
    file.close();

    if (pngData.size() < 8)
        return {};

    // Validate full 8-byte PNG signature: \x89PNG\r\n\x1a\n
    static constexpr char kPngSignature[8] = {
        '\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n'
    };
    if (!pngData.startsWith(QByteArray::fromRawData(kPngSignature, 8)))
        return {};

    // Write extracted PNG to cache
    QDir().mkpath(QFileInfo(cachePath).absolutePath());

    QFile output(cachePath);
    if (!output.open(QIODevice::WriteOnly))
        return {};

    if (output.write(pngData) != pngData.size()) {
        output.close();
        QFile::remove(cachePath);
        return {};
    }

    output.close();
    return cachePath;
}

} // namespace IcnsDecoder

} // namespace symmetria::filemanager::models
