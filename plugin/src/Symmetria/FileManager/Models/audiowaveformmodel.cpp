#include "audiowaveformmodel.hpp"

#include <qaudiobuffer.h>
#include <qurl.h>

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace symmetria::filemanager::models {

AudioWaveformModel::AudioWaveformModel(QObject* parent)
    : QObject(parent) {}

AudioWaveformModel::~AudioWaveformModel() {
    cleanup();
}

QString AudioWaveformModel::filePath() const { return m_filePath; }

void AudioWaveformModel::setFilePath(const QString& path) {
    if (m_filePath == path)
        return;
    m_filePath = path;
    emit filePathChanged();
    startDecode();
}

QList<qreal> AudioWaveformModel::peaks() const { return m_peaks; }
qint64 AudioWaveformModel::duration() const { return m_duration; }
bool AudioWaveformModel::loading() const { return m_loading; }
QString AudioWaveformModel::error() const { return m_error; }

void AudioWaveformModel::cleanup() {
    if (m_decoder) {
        m_decoder->stop();
        m_decoder->deleteLater();
        m_decoder = nullptr;
    }
    m_rawPeaks.clear();
    m_binSampleCount = 0;
    m_binMax = 0.0f;
    m_samplesPerBin = 0;
    m_sampleRate = 0;
    m_durationEstimated = false;
}

void AudioWaveformModel::startDecode() {
    const int generation = ++m_generation;

    cleanup();

    // Clear previous results
    if (!m_peaks.isEmpty()) {
        m_peaks.clear();
        emit peaksChanged();
    }
    if (m_duration != 0) {
        m_duration = 0;
        emit durationChanged();
    }

    const bool hadError = !m_error.isEmpty();
    m_error.clear();

    if (m_filePath.isEmpty()) {
        m_loading = false;
        emit loadingChanged();
        if (hadError) emit errorChanged();
        return;
    }

    m_loading = true;
    emit loadingChanged();
    if (hadError) emit errorChanged();

    m_decoder = new QAudioDecoder(this);
    m_decoder->setSource(QUrl::fromLocalFile(m_filePath));

    connect(m_decoder, &QAudioDecoder::bufferReady, this,
        [this, generation]() {
            if (generation != m_generation)
                return;
            onBufferReady();
        });

    connect(m_decoder, &QAudioDecoder::finished, this,
        [this, generation]() {
            if (generation != m_generation)
                return;
            onFinished();
        });

    connect(m_decoder, qOverload<QAudioDecoder::Error>(&QAudioDecoder::error), this,
        [this, generation](QAudioDecoder::Error decoderError) {
            if (generation != m_generation)
                return;
            onDecoderError(decoderError);
        });

    // Listen for duration from metadata once available
    connect(m_decoder, &QAudioDecoder::durationChanged, this,
        [this, generation](qint64 dur) {
            if (generation != m_generation)
                return;
            if (dur > 0 && m_duration != dur) {
                m_duration = dur;
                emit durationChanged();
            }
        });

    m_decoder->start();
}

void AudioWaveformModel::onBufferReady() {
    if (!m_decoder)
        return;

    const QAudioBuffer buffer = m_decoder->read();
    if (!buffer.isValid())
        return;

    // On first buffer, estimate bin width from duration and sample rate
    if (!m_durationEstimated) {
        const auto format = buffer.format();
        m_sampleRate = format.sampleRate();

        // Try to get duration from decoder metadata
        qint64 dur = m_decoder->duration();
        if (dur <= 0) {
            // Fallback: use a default estimate, will redistribute on finish
            dur = 180000; // assume 3 minutes
        }

        if (m_duration != dur && dur > 0) {
            m_duration = dur;
            emit durationChanged();
        }

        // Total mono samples = sampleRate * (duration_ms / 1000)
        const qint64 totalSamples = static_cast<qint64>(m_sampleRate)
            * m_duration / 1000;
        m_samplesPerBin = std::max(1, static_cast<int>(totalSamples / TargetBinCount));
        m_rawPeaks.reserve(TargetBinCount + 64); // small overallocation
        m_durationEstimated = true;
    }

    processBuffer(buffer);
}

void AudioWaveformModel::processBuffer(const QAudioBuffer& buffer) {
    const auto format = buffer.format();
    const int channelCount = format.channelCount();
    const auto frameCount = buffer.frameCount();

    // Process based on sample format
    if (format.sampleFormat() == QAudioFormat::Int16) {
        const auto* data = buffer.constData<int16_t>();
        for (qsizetype f = 0; f < frameCount; ++f) {
            // Take max absolute value across channels (mono reduction)
            float sample = 0.0f;
            for (int ch = 0; ch < channelCount; ++ch) {
                const float val = std::abs(static_cast<float>(data[f * channelCount + ch])
                    / 32768.0f);
                sample = std::max(sample, val);
            }

            m_binMax = std::max(m_binMax, sample);
            m_binSampleCount++;

            if (m_binSampleCount >= m_samplesPerBin) {
                m_rawPeaks.append(m_binMax);
                m_binMax = 0.0f;
                m_binSampleCount = 0;
            }
        }
    } else if (format.sampleFormat() == QAudioFormat::Float) {
        const auto* data = buffer.constData<float>();
        for (qsizetype f = 0; f < frameCount; ++f) {
            float sample = 0.0f;
            for (int ch = 0; ch < channelCount; ++ch) {
                const float val = std::abs(data[f * channelCount + ch]);
                sample = std::max(sample, val);
            }

            m_binMax = std::max(m_binMax, sample);
            m_binSampleCount++;

            if (m_binSampleCount >= m_samplesPerBin) {
                m_rawPeaks.append(m_binMax);
                m_binMax = 0.0f;
                m_binSampleCount = 0;
            }
        }
    } else if (format.sampleFormat() == QAudioFormat::Int32) {
        const auto* data = buffer.constData<int32_t>();
        for (qsizetype f = 0; f < frameCount; ++f) {
            float sample = 0.0f;
            for (int ch = 0; ch < channelCount; ++ch) {
                const float val = std::abs(static_cast<float>(data[f * channelCount + ch])
                    / 2147483648.0f);
                sample = std::max(sample, val);
            }

            m_binMax = std::max(m_binMax, sample);
            m_binSampleCount++;

            if (m_binSampleCount >= m_samplesPerBin) {
                m_rawPeaks.append(m_binMax);
                m_binMax = 0.0f;
                m_binSampleCount = 0;
            }
        }
    }
    // UInt8 is uncommon for music files — skip silently
}

void AudioWaveformModel::onFinished() {
    // Flush any remaining samples in the last bin
    if (m_binSampleCount > 0) {
        m_rawPeaks.append(m_binMax);
    }

    // Update duration from actual decoded sample count if we had an estimate
    if (m_sampleRate > 0 && !m_rawPeaks.isEmpty()) {
        const qint64 totalSamples = static_cast<qint64>(m_rawPeaks.size())
            * m_samplesPerBin;
        const qint64 actualDuration = totalSamples * 1000 / m_sampleRate;
        if (m_duration != actualDuration) {
            m_duration = actualDuration;
            emit durationChanged();
        }
    }

    finalizePeaks();

    m_loading = false;
    emit loadingChanged();
}

void AudioWaveformModel::finalizePeaks() {
    if (m_rawPeaks.isEmpty()) {
        m_peaks.clear();
        emit peaksChanged();
        return;
    }

    // Find global max for normalization
    float globalMax = 0.0f;
    for (const float peak : m_rawPeaks) {
        globalMax = std::max(globalMax, peak);
    }

    // Avoid division by zero for silent files
    if (globalMax < 1e-6f) {
        m_peaks.fill(0.0, TargetBinCount);
        emit peaksChanged();
        return;
    }

    // Resample raw peaks to exactly TargetBinCount using nearest-neighbor
    const auto rawCount = m_rawPeaks.size();
    QList<qreal> normalized;
    normalized.reserve(TargetBinCount);

    for (int i = 0; i < TargetBinCount; ++i) {
        // Map target bin to raw bin range
        const auto rawStart = static_cast<qsizetype>(i) * rawCount / TargetBinCount;
        const auto rawEnd = static_cast<qsizetype>(i + 1) * rawCount / TargetBinCount;

        // Take max within the mapped range for visual fidelity.
        // When rawCount < TargetBinCount (e.g. short files), rawStart == rawEnd
        // for most target bins — the loop body would never execute, producing
        // silent bars. Fall back to nearest-neighbor in that case.
        float binMax = 0.0f;
        if (rawStart < rawEnd) {
            for (auto r = rawStart; r < rawEnd && r < rawCount; ++r) {
                binMax = std::max(binMax, m_rawPeaks[r]);
            }
        } else if (rawStart < rawCount) {
            binMax = m_rawPeaks[rawStart];
        }

        normalized.append(static_cast<qreal>(binMax / globalMax));
    }

    m_peaks = std::move(normalized);
    emit peaksChanged();
}

void AudioWaveformModel::onDecoderError(QAudioDecoder::Error decoderError) {
    Q_UNUSED(decoderError);
    m_error = m_decoder ? m_decoder->errorString()
                        : QStringLiteral("Unknown decoder error");
    m_loading = false;
    emit errorChanged();
    emit loadingChanged();
}

} // namespace symmetria::filemanager::models
