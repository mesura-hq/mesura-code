#pragma once

// AudioWaveformModel — QML element for generating waveform peak data from audio files.
//
// Decodes audio via QAudioDecoder (Qt6 Multimedia / FFmpeg backend) and produces
// a list of ~300 normalized peak values (0.0–1.0) for bar-style waveform rendering
// in QML Canvas.
//
// Key design decisions:
//
//   1. Streaming peak accumulation — samples are binned on-the-fly as
//      QAudioDecoder emits bufferReady(). Only the running max per bin is
//      stored, so memory usage is O(binCount) regardless of file duration.
//
//   2. No QtConcurrent — QAudioDecoder is already asynchronous (backed by
//      FFmpeg in a worker thread). Wrapping it in QtConcurrent would require
//      a nested event loop.
//
//   3. Generation counter — same stale-result rejection pattern as
//      ArchivePreviewModel. When filePath changes mid-decode, the old
//      decoder's results are silently discarded.

#include <qaudiodecoder.h>
#include <qobject.h>
#include <qqmlintegration.h>

namespace symmetria::filemanager::models {

class AudioWaveformModel : public QObject {
    Q_OBJECT
    QML_ELEMENT

    // Input property (set from QML)
    Q_PROPERTY(QString filePath READ filePath WRITE setFilePath NOTIFY filePathChanged)

    // Output data
    Q_PROPERTY(QList<qreal> peaks READ peaks NOTIFY peaksChanged)
    Q_PROPERTY(qint64 duration READ duration NOTIFY durationChanged)
    Q_PROPERTY(bool loading READ loading NOTIFY loadingChanged)
    Q_PROPERTY(QString error READ error NOTIFY errorChanged)

public:
    explicit AudioWaveformModel(QObject* parent = nullptr);
    ~AudioWaveformModel() override;

    static constexpr int TargetBinCount = 300;

    [[nodiscard]] QString filePath() const;
    void setFilePath(const QString& path);

    [[nodiscard]] QList<qreal> peaks() const;
    [[nodiscard]] qint64 duration() const;
    [[nodiscard]] bool loading() const;
    [[nodiscard]] QString error() const;

signals:
    void filePathChanged();
    void peaksChanged();
    void durationChanged();
    void loadingChanged();
    void errorChanged();

private:
    void startDecode();
    void cleanup();
    void onBufferReady();
    void onFinished();
    void onDecoderError(QAudioDecoder::Error decoderError);

    // Extract peak from a single QAudioBuffer, accumulating into m_rawPeaks
    void processBuffer(const QAudioBuffer& buffer);

    // Normalize raw peaks into the final m_peaks list
    void finalizePeaks();

    QString m_filePath;
    QList<qreal> m_peaks;
    qint64 m_duration = 0;
    bool m_loading = false;
    QString m_error;
    int m_generation = 0;

    QAudioDecoder* m_decoder = nullptr;

    // Streaming accumulation state
    QVector<float> m_rawPeaks;
    int m_samplesPerBin = 0;      // samples per bin (estimated from duration + sample rate)
    int m_binSampleCount = 0;     // samples accumulated in current bin
    float m_binMax = 0.0f;        // running max for current bin
    int m_sampleRate = 0;         // detected sample rate
    bool m_durationEstimated = false;
};

} // namespace symmetria::filemanager::models
