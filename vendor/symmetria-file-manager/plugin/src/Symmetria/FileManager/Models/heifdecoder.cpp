#include "heifdecoder.hpp"

#include <qdebug.h>
#include <qdir.h>
#include <qfile.h>
#include <qfileinfo.h>
#include <qimage.h>

#include <libheif/heif.h>

namespace symmetria::filemanager::models {

namespace {
// Cap the cached preview's largest dimension. Phone HEICs are 12MP+ (e.g.
// 4032x3024); decoding and PNG-encoding them at native resolution would burn
// CPU and disk for detail the preview pane never shows — opening a file
// launches the real viewer via xdg-open. 2048 keeps HiDPI crispness in the pane.
constexpr int kMaxPreviewDim = 2048;
} // namespace

namespace HeifDecoder {

QString decodeToPng(const QString& sourcePath, const QString& cachePath) {
    // libheif >= 1.13 initializes a decoder-plugin registry (libde265 et al. are
    // dynamically-loaded plugins on some distros). Initialize it explicitly
    // rather than leaning on lazy self-init, whose availability is version- and
    // distro-dependent. The guard pairs heif_deinit() to every return path;
    // init/deinit are refcounted and thread-safe, so concurrent decodes are fine.
    struct HeifInitGuard {
        HeifInitGuard() { heif_init(nullptr); }
        ~HeifInitGuard() { heif_deinit(); }
    } heifInitGuard;

    heif_context* ctx = heif_context_alloc();
    if (!ctx)
        return {};

    // libheif is a C API with manual resource ownership. freeCtx handles the
    // early-return paths (before any image/handle exists); the decode-failure
    // and success paths release img/handle explicitly before freeing ctx.
    auto freeCtx = [&]() -> QString {
        heif_context_free(ctx);
        return {};
    };

    // Keep the UTF-8 buffer alive for the whole read call (constData() would
    // otherwise point into a destroyed temporary).
    const QByteArray srcUtf8 = sourcePath.toUtf8();
    heif_error err = heif_context_read_from_file(ctx, srcUtf8.constData(), nullptr);
    if (err.code != heif_error_Ok)
        return freeCtx();

    heif_image_handle* handle = nullptr;
    err = heif_context_get_primary_image_handle(ctx, &handle);
    if (err.code != heif_error_Ok || !handle)
        return freeCtx();

    // Decode to straight (non-premultiplied) 8-bit interleaved RGBA — matches
    // QImage::Format_RGBA8888 so the wrap below is a plain reinterpretation.
    heif_image* img = nullptr;
    err = heif_decode_image(handle, &img, heif_colorspace_RGB,
                            heif_chroma_interleaved_RGBA, nullptr);
    if (err.code != heif_error_Ok || !img) {
        // libheif's own explanation, which this used to discard.
        //
        // Not noise: the usual cause is a libheif built with NO decoder plugin
        // for HEVC, which reports "Unsupported codec" and produces an empty
        // result indistinguishable from a corrupt file. That cost a CI
        // investigation — the test failed with a bare string mismatch and the
        // one message that would have named the cause had been thrown away.
        // Debian and Ubuntu split the decoders out: libheif-plugin-libde265.
        qWarning("HeifDecoder: libheif could not decode %s: %s",
                 qUtf8Printable(sourcePath), err.message ? err.message : "(no message)");
        heif_image_handle_release(handle);
        return freeCtx();
    }

    const int width  = heif_image_get_width(img, heif_channel_interleaved);
    const int height = heif_image_get_height(img, heif_channel_interleaved);

    int stride = 0;
    const uint8_t* data =
        heif_image_get_plane_readonly(img, heif_channel_interleaved, &stride);

    QImage image;
    if (data && width > 0 && height > 0) {
        // Wrap the libheif-owned plane, then deep-copy so the QImage owns its
        // pixels before we release the libheif buffers below.
        image = QImage(data, width, height, stride, QImage::Format_RGBA8888).copy();
    }

    heif_image_release(img);
    heif_image_handle_release(handle);
    heif_context_free(ctx);

    if (image.isNull())
        return {};

    // Downscale oversized photos to preview resolution before encoding (see
    // kMaxPreviewDim). KeepAspectRatio caps the larger dimension at the limit.
    if (image.width() > kMaxPreviewDim || image.height() > kMaxPreviewDim)
        image = image.scaled(kMaxPreviewDim, kMaxPreviewDim,
                             Qt::KeepAspectRatio, Qt::SmoothTransformation);

    QDir().mkpath(QFileInfo(cachePath).absolutePath());
    if (!image.save(cachePath, "PNG")) {
        // Remove any partial file: the upstream cache-hit check is a bare
        // QFileInfo::exists(), so a truncated write would later be served as a
        // valid cached preview (matches the ICNS/RPGMV cleanup discipline).
        QFile::remove(cachePath);
        return {};
    }

    return cachePath;
}

} // namespace HeifDecoder

} // namespace symmetria::filemanager::models
