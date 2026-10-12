// Prueba del núcleo: la señal "procesada" (más fuerte) debe acabar al nivel de la de referencia.
#include "Source/LoudnessMatcher.h"
#include <cstdio>
#include <vector>
int main()
{
    const double fs = 48000.0; const int block = 512;
    mg::LoudnessMeter ref, own; mg::GainFollower follower;
    ref.prepare (fs); own.prepare (fs); follower.prepare (fs);
    auto gen = [&](double amp, long& n, std::vector<float>& out) {
        for (int i = 0; i < block; ++i, ++n)
            out[(size_t) i] = (float) (amp * (0.6 * std::sin (2 * M_PI * 220.0 * n / fs) + 0.4 * std::sin (2 * M_PI * 1760.0 * n / fs)));
    };
    long n = 0; std::vector<float> a ((size_t) block), b ((size_t) block);
    float refL = 0, ownL = 0; double g = 0;
    for (int blk = 0; blk < (int) (20 * fs / block); ++blk)
    {
        gen (0.1, n, a);                       // entrada original
        std::vector<float> proc (a);           // "efecto": +9 dB
        for (auto& s : proc) s *= 2.8184f;
        const float* pa[] = { a.data() }; const float* pp[] = { proc.data() };
        refL = ref.process (pa, 1, block);
        ownL = own.process (pp, 1, block);
        g = follower.update (refL, ownL, block, 1.0, 24.0, 0.0, false);
    }
    const double outL = ownL + g;
    std::printf ("ref %.2f LUFS  entrada-match %.2f LUFS  ganancia %.2f dB  salida %.2f LUFS\n", refL, ownL, g, outL);
    const bool ok = std::fabs (outL - refL) < 0.2 && std::fabs (g + 9.0) < 0.3;
    // silencio: la ganancia no debe moverse
    std::vector<float> z ((size_t) block, 0.0f); const float* pz[] = { z.data() };
    const float l2 = own.process (pz, 1, block);
    std::printf ("tras silencio: %.2f LUFS (debe seguir igual)  -> %s\n", l2, ok && std::fabs (l2 - ownL) < 0.1 ? "OK" : "FALLO");
    return ok ? 0 : 1;
}
