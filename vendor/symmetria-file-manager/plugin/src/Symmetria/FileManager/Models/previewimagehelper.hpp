#pragma once

#include <qfuturewatcher.h>
#include <qobject.h>
#include <qqmlintegration.h>

namespace symmetria::filemanager::models {

class PreviewImageHelper : public QObject {
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(QString source READ source WRITE setSource NOTIFY sourceChanged)
    Q_PROPERTY(QString resolvedUrl READ resolvedUrl NOTIFY resolvedUrlChanged)
    Q_PROPERTY(bool loading READ loading NOTIFY loadingChanged)

public:
    explicit PreviewImageHelper(QObject* parent = nullptr);
    ~PreviewImageHelper() override;

    [[nodiscard]] QString source() const;
    void setSource(const QString& path);

    [[nodiscard]] QString resolvedUrl() const;
    [[nodiscard]] bool loading() const;

    /// Path to launch with xdg-open. Redirects to the cached file ONLY for
    /// formats whose cache IS the user-facing artifact (decrypted .rpgmvp /
    /// .png_). PDFs, ICNS, and all other files open by their source path so
    /// the user's configured handler (e.g. sioyek for PDF) is invoked.
    /// Side-effect: on a cache miss for RPGMV formats, this method writes
    /// the decrypted PNG to the preview cache (synchronous, < 1ms per file).
    Q_INVOKABLE static QString resolvePathForOpen(const QString& path);

    /// Path for the preview pane to render. Returns the cached PNG if one
    /// already exists for this source (any format that supports cached
    /// previews), otherwise the source path. Never generates the cache —
    /// asynchronous generation lives in processSource().
    /// Note: for RPGMV formats (.rpgmvp / .png_), a cache-miss return value
    /// is the raw encrypted source path, which Qt cannot decode. The caller
    /// must ensure a PreviewImageHelper instance with the same source is
    /// running processSource() to populate the cache asynchronously.
    Q_INVOKABLE static QString resolvePathForPreview(const QString& path);

signals:
    void sourceChanged();
    void resolvedUrlChanged();
    void loadingChanged();

private:
    void processSource();
    void applyResolvedUrl(const QString& url);
    static bool needsCachedDecode(const QString& path);
    static bool isRpgmvFormat(const QString& path);
    static bool isHeifFormat(const QString& path);
    static bool cacheIsOpenableArtifact(const QString& path);
    static QString cachedPreviewPathFor(const QString& sourcePath);
    static QString generateCachedPreview(const QString& sourcePath, const QString& cachePath);
    static QString decryptRpgmvp(const QString& sourcePath, const QString& cachePath);
    static const QString& cacheDir();

    QString m_source;
    QString m_resolvedUrl;
    bool m_loading = false;
    QFutureWatcher<QString>* m_watcher = nullptr;
};

} // namespace symmetria::filemanager::models
