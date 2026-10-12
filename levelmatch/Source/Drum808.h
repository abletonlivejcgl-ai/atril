#pragma once
// Caja de ritmos estilo 808, sintetizada (sin muestras). Sin dependencias de JUCE para poder probarla sola.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace d808
{
constexpr double kPi = 3.14159265358979323846;

struct Rng
{
    uint32_t s = 22222u;
    float next() noexcept { s = s * 1664525u + 1013904223u; return (float) (s >> 8) * (2.0f / 16777216.0f) - 1.0f; }
};

// Filtro de estado variable (TPT). Salidas: paso alto, paso banda, paso bajo.
struct SVF
{
    double g = 0, k = 1, a1 = 0, a2 = 0, a3 = 0, ic1 = 0, ic2 = 0;
    void set (double fs, double f, double Q)
    {
        g = std::tan (kPi * std::min (f, fs * 0.45) / fs);
        k = 1.0 / Q;
        a1 = 1.0 / (1.0 + g * (g + k)); a2 = g * a1; a3 = g * a2;
    }
    void reset() { ic1 = ic2 = 0; }
    inline void run (double x, double& hp, double& bp, double& lp)
    {
        const double v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
        bp = v1; lp = v2; hp = x - k * v1 - v2;
    }
};

struct Params
{
    float kickTune = 0.0f;     // semitonos
    float kickDecay = 0.8f;    // segundos hasta -60 dB
    float snareTone = 0.5f;    // 0..1 (mas cuerpo)
    float snareSnap = 0.5f;    // 0..1 (mas ruido)
    float tomTune = 0.0f;      // semitonos
    float openHatDecay = 0.35f;// segundos
    float master = 0.8f;
};

enum Voice { Kick, Snare, Clap, ClosedHat, OpenHat, TomLow, TomMid, TomHigh, Rim, Cowbell, Cymbal, kVoices };

class Engine
{
public:
    void prepare (double sampleRate)
    {
        fs = sampleRate;
        for (auto& v : st) v = {};
        hatHP.set (fs, 7000.0, 0.8); cymHP.set (fs, 5500.0, 0.7);
        clapBP.set (fs, 1100.0, 1.6); snareHP.set (fs, 1800.0, 0.7); cowBP.set (fs, 2600.0, 1.4);
    }

    // Nota MIDI (General MIDI) -> voz. Devuelve false si no es una nota de batería conocida.
    static int voiceForNote (int note)
    {
        switch (note)
        {
            case 35: case 36: return Kick;
            case 38: case 40: return Snare;
            case 39: return Clap;
            case 42: case 44: return ClosedHat;
            case 46: return OpenHat;
            case 41: case 43: return TomLow;
            case 45: case 47: return TomMid;
            case 48: case 50: return TomHigh;
            case 37: return Rim;
            case 56: return Cowbell;
            case 49: case 51: case 52: case 55: case 57: return Cymbal;
            default: return -1;
        }
    }

    void trigger (int voice, float velocity)
    {
        if (voice < 0 || voice >= kVoices) return;
        auto& s = st[(size_t) voice];
        s.t = 0.0; s.on = true; s.vel = std::clamp (velocity, 0.05f, 1.0f); s.ph[0] = s.ph[1] = 0.0;
        if (voice == Kick || voice == Snare || voice == TomLow || voice == TomMid || voice == TomHigh) {}
        else if (voice == ClosedHat) st[OpenHat].on = false;       // el hi-hat cerrado corta al abierto
        if (voice == ClosedHat || voice == OpenHat || voice == Cymbal) { hatHP.reset(); cymHP.reset(); }
        if (voice == Clap) clapBP.reset();
        if (voice == Snare) snareHP.reset();
        if (voice == Cowbell) cowBP.reset();
    }

    bool active() const { for (auto& s : st) if (s.on) return true; return false; }

    inline float process (const Params& p)
    {
        const double dt = 1.0 / fs;
        double out = 0.0;
        for (int v = 0; v < kVoices; ++v)
        {
            auto& s = st[(size_t) v];
            if (! s.on) continue;
            const double t = s.t;
            double y = 0.0, amp = 1.0;
            switch (v)
            {
                case Kick:
                {
                    const double base = 49.0 * std::pow (2.0, p.kickTune / 12.0);
                    const double f = base + base * 1.6 * std::exp (-t / 0.018) ;
                    s.ph[0] += f * dt;
                    const double tau = std::max (0.05, (double) p.kickDecay) / 6.9;
                    amp = std::exp (-t / tau) * std::min (1.0, t / 0.0006);
                    y = std::tanh (1.8 * std::sin (2 * kPi * s.ph[0])) * 0.9 * amp;
                    if (amp < 1e-4 && t > 0.05) s.on = false;
                    break;
                }
                case Snare:
                {
                    s.ph[0] += 180.0 * dt; s.ph[1] += 330.0 * dt;
                    const double tone = (std::sin (2 * kPi * s.ph[0]) * std::exp (-t / 0.07)
                                         + 0.6 * std::sin (2 * kPi * s.ph[1]) * std::exp (-t / 0.045)) * (0.4 + 0.9 * p.snareTone);
                    double hp, bp, lp; snareHP.run (rng.next(), hp, bp, lp);
                    const double noise = hp * std::exp (-t / (0.05 + 0.14 * p.snareSnap)) * (0.2 + 0.6 * p.snareSnap);
                    y = (tone + noise) * 0.7;
                    if (t > 0.9) s.on = false;
                    break;
                }
                case Clap:
                {
                    double hp, bp, lp; clapBP.run (rng.next(), hp, bp, lp);
                    double env = 0.0;
                    const double bursts[4] = { 0.0, 0.011, 0.022, 0.033 };
                    for (int b = 0; b < 4; ++b)
                        if (t >= bursts[b])
                            env = std::max (env, std::exp (-(t - bursts[b]) / (b < 3 ? 0.0035 : 0.09)));
                    y = bp * env * 3.0;
                    if (t > 0.8) s.on = false;
                    break;
                }
                case ClosedHat: case OpenHat: case Cymbal:
                {
                    static const double fr[6] = { 205.3, 304.4, 369.6, 522.7, 540.0, 800.0 };
                    const double mul = (v == Cymbal) ? 1.0 : 2.6; // el hat suena mas agudo
                    double sum = 0.0;
                    for (int i = 0; i < 6; ++i)
                    {
                        s.hp6[i] += fr[i] * mul * dt; s.hp6[i] -= std::floor (s.hp6[i]);
                        sum += s.hp6[i] < 0.5 ? 1.0 : -1.0;
                    }
                    double hp, bp, lp;
                    if (v == Cymbal) cymHP.run (sum / 6.0, hp, bp, lp); else hatHP.run (sum / 6.0, hp, bp, lp);
                    const double tau = v == ClosedHat ? 0.022 : v == OpenHat ? std::max (0.05, (double) p.openHatDecay) / 6.9 * 1.0 : 0.55;
                    amp = std::exp (-t / tau) * std::min (1.0, t / 0.0004);
                    y = hp * amp * (v == Cymbal ? 2.0 : 2.6);
                    if (amp < 1e-4 && t > 0.02) s.on = false;
                    break;
                }
                case TomLow: case TomMid: case TomHigh:
                {
                    const double f0 = (v == TomLow ? 92.0 : v == TomMid ? 130.0 : 185.0) * std::pow (2.0, p.tomTune / 12.0);
                    const double f = f0 * (1.0 + 0.45 * std::exp (-t / 0.03));
                    s.ph[0] += f * dt;
                    const double tau = v == TomLow ? 0.13 : v == TomMid ? 0.11 : 0.09;
                    amp = std::exp (-t / tau) * std::min (1.0, t / 0.0006);
                    y = std::sin (2 * kPi * s.ph[0]) * amp * 0.9;
                    if (amp < 1e-4 && t > 0.02) s.on = false;
                    break;
                }
                case Rim:
                {
                    s.ph[0] += 1700.0 * dt; s.ph[1] += 480.0 * dt;
                    amp = std::exp (-t / 0.006);
                    y = (std::tanh (2.0 * std::sin (2 * kPi * s.ph[0])) + std::sin (2 * kPi * s.ph[1])) * 0.5 * amp
                        + rng.next() * 0.2 * std::exp (-t / 0.003);
                    if (t > 0.1) s.on = false;
                    break;
                }
                case Cowbell:
                {
                    s.hp6[0] += 540.0 * dt; s.hp6[0] -= std::floor (s.hp6[0]);
                    s.hp6[1] += 800.0 * dt; s.hp6[1] -= std::floor (s.hp6[1]);
                    const double sq = (s.hp6[0] < 0.5 ? 1.0 : -1.0) + (s.hp6[1] < 0.5 ? 1.0 : -1.0);
                    double hp, bp, lp; cowBP.run (sq * 0.5, hp, bp, lp);
                    amp = 0.55 * std::exp (-t / 0.012) + 0.45 * std::exp (-t / 0.11);
                    y = bp * amp * 1.4;
                    if (t > 0.9) s.on = false;
                    break;
                }
            }
            s.t += dt;
            out += y * s.vel;
        }
        return (float) std::tanh (out * p.master);
    }

private:
    struct State { double t = 0; bool on = false; float vel = 1; double ph[2] = { 0, 0 }; double hp6[6] = { 0, 0, 0, 0, 0, 0 }; };
    double fs = 44100.0;
    std::array<State, kVoices> st;
    Rng rng;
    SVF hatHP, cymHP, clapBP, snareHP, cowBP;
};
}
