#pragma once
// Núcleo de medición y ajuste de volumen. No depende de JUCE para poder probarlo solo.
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>

namespace mg
{
constexpr int kGroups = 8;
constexpr float kNoLevel = -200.0f;

// Nivel de referencia compartido entre todas las instancias del plugin dentro del mismo programa (la DAW).
// Cada grupo guarda el volumen (en LUFS) de la señal ANTES de los efectos.
inline std::array<std::atomic<float>, kGroups>& sharedReference()
{
    struct Registry
    {
        std::array<std::atomic<float>, kGroups> levels;
        Registry() { for (auto& v : levels) v.store (kNoLevel); }
    };
    static Registry registry;
    return registry.levels;
}

// Un biquad en forma transpuesta II.
struct Biquad
{
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
    inline double process (double x) noexcept
    {
        const double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
    void reset() noexcept { z1 = z2 = 0; }
};

// Filtro de ponderación K (ITU-R BS.1770): realce de agudos + corte de graves.
struct KWeighting
{
    Biquad shelf, highpass;

    void prepare (double fs)
    {
        const double pi = 3.14159265358979323846;
        {
            const double f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
            const double K = std::tan (pi * f0 / fs);
            const double Vh = std::pow (10.0, G / 20.0);
            const double Vb = std::pow (Vh, 0.4996667741545416);
            const double a0 = 1.0 + K / Q + K * K;
            shelf.b0 = (Vh + Vb * K / Q + K * K) / a0;
            shelf.b1 = 2.0 * (K * K - Vh) / a0;
            shelf.b2 = (Vh - Vb * K / Q + K * K) / a0;
            shelf.a1 = 2.0 * (K * K - 1.0) / a0;
            shelf.a2 = (1.0 - K / Q + K * K) / a0;
        }
        {
            const double f0 = 38.13547087602444, Q = 0.5003270373238773;
            const double K = std::tan (pi * f0 / fs);
            const double a0 = 1.0 + K / Q + K * K;
            highpass.b0 = 1.0; highpass.b1 = -2.0; highpass.b2 = 1.0;
            highpass.a1 = 2.0 * (K * K - 1.0) / a0;
            highpass.a2 = (1.0 - K / Q + K * K) / a0;
        }
        reset();
    }
    void reset() noexcept { shelf.reset(); highpass.reset(); }
    inline double process (double x) noexcept { return highpass.process (shelf.process (x)); }
};

inline float msToLufs (double ms) noexcept { return ms > 1.0e-12 ? (float) (-0.691 + 10.0 * std::log10 (ms)) : kNoLevel; }

// Mide el volumen (LUFS) con una media móvil lenta y no cuenta los silencios.
class LoudnessMeter
{
public:
    static constexpr int kMaxCh = 2;

    void prepare (double sampleRate, double timeConstantSeconds = 1.5)
    {
        fs = sampleRate;
        tau = timeConstantSeconds;
        for (auto& k : filters) k.prepare (fs);
        reset();
    }
    void reset() noexcept
    {
        for (auto& k : filters) k.reset();
        ms = 0.0;
        valid = false;
    }

    // Procesa un bloque (sin modificarlo) y devuelve el volumen actual en LUFS, o kNoLevel si aún no hay señal.
    float process (const float* const* data, int numChannels, int numSamples) noexcept
    {
        if (numSamples <= 0) return level();
        const int ch = std::min (numChannels, kMaxCh);
        double sum = 0.0;
        for (int c = 0; c < ch; ++c)
        {
            double acc = 0.0;
            for (int i = 0; i < numSamples; ++i)
            {
                const double y = kWeighted ? filters[(size_t) c].process ((double) data[c][i]) : (double) data[c][i];
                acc += y * y;
            }
            sum += acc / numSamples;
        }
        if (msToLufs (sum) > gateLufs)               // los silencios no cambian la medida
        {
            if (! valid) { ms = sum; valid = true; }
            else
            {
                const double a = 1.0 - std::exp (-(double) numSamples / (fs * tau));
                ms += (sum - ms) * a;
            }
        }
        return level();
    }
    // Con kWeighted = false devuelve RMS en dBFS (sin ponderación ni el -0.691 de LUFS).
    float level() const noexcept
    {
        if (! valid) return kNoLevel;
        const float v = msToLufs (ms);
        return (kWeighted || v <= kNoLevel) ? v : v + 0.691f;
    }
    bool kWeighted = true;

    float gateLufs = -70.0f;

private:
    double fs = 44100.0, tau = 1.5, ms = 0.0;
    bool valid = false;
    std::array<KWeighting, kMaxCh> filters;
};

// Calcula la ganancia (dB) que iguala el volumen propio al de referencia, con cambios suaves.
class GainFollower
{
public:
    void prepare (double sampleRate) { fs = sampleRate; reset(); }
    void reset() noexcept { gainDb = 0.0; }

    // Devuelve la ganancia a aplicar al final de este bloque.
    double update (float refLufs, float ownLufs, int numSamples, double speedSeconds,
                   double maxGainDb, double trimDb, bool freeze) noexcept
    {
        if (! freeze && refLufs > kNoLevel && ownLufs > kNoLevel)
        {
            const double target = std::clamp ((double) refLufs - (double) ownLufs, -maxGainDb, maxGainDb);
            const double a = 1.0 - std::exp (-(double) numSamples / (fs * std::max (0.05, speedSeconds)));
            gainDb += (target - gainDb) * a;
        }
        return gainDb + trimDb;
    }
    double current() const noexcept { return gainDb; }

private:
    double fs = 44100.0, gainDb = 0.0;
};
}
