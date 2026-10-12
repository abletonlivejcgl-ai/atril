#include "GainStageProcessor.h"
#include "GainStageEditor.h"

using APVTS = juce::AudioProcessorValueTreeState;

APVTS::ParameterLayout GainStageProcessor::createLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    p.push_back (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { "target", 1 }, "Nivel objetivo (dB)",
                 juce::NormalisableRange<float> (-40.0f, -6.0f, 0.1f), -18.0f));
    p.push_back (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID { "measure", 1 }, "Medicion",
                 juce::StringArray { "RMS (dBFS)", "LUFS" }, 0));
    p.push_back (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { "speed", 1 }, "Velocidad (s)",
                 juce::NormalisableRange<float> (0.2f, 10.0f, 0.01f, 0.5f), 3.0f));
    p.push_back (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { "maxgain", 1 }, "Ganancia maxima (dB)",
                 juce::NormalisableRange<float> (6.0f, 40.0f, 0.1f), 24.0f));
    p.push_back (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { "trim", 1 }, "Ajuste fino (dB)",
                 juce::NormalisableRange<float> (-12.0f, 12.0f, 0.1f), 0.0f));
    p.push_back (std::make_unique<juce::AudioParameterBool> (juce::ParameterID { "freeze", 1 }, "Congelar", false));
    return { p.begin(), p.end() };
}

GainStageProcessor::GainStageProcessor()
    : AudioProcessor (BusesProperties().withInput ("Input", juce::AudioChannelSet::stereo(), true)
                                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "STATE", createLayout())
{
    pTarget = apvts.getRawParameterValue ("target");
    pMode = apvts.getRawParameterValue ("measure");
    pSpeed = apvts.getRawParameterValue ("speed");
    pMaxGain = apvts.getRawParameterValue ("maxgain");
    pTrim = apvts.getRawParameterValue ("trim");
    pFreeze = apvts.getRawParameterValue ("freeze");
}

bool GainStageProcessor::isBusesLayoutSupported (const BusesLayout& l) const
{
    const auto& in = l.getMainInputChannelSet();
    return in == l.getMainOutputChannelSet() && (in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo());
}

void GainStageProcessor::prepareToPlay (double sr, int)
{
    meter.prepare (sr, 1.5);
    follower.prepare (sr);
    lastGainDb = 0.0;
}

void GainStageProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples(), ch = buffer.getNumChannels();
    if (n == 0) return;

    const bool weighted = (int) pMode->load() == 1;
    if (weighted != lastWeighted) { meter.kWeighted = weighted; meter.reset(); lastWeighted = weighted; }

    const float own = meter.process (buffer.getArrayOfReadPointers(), ch, n);
    // El "nivel de referencia" es siempre el objetivo fijo.
    const double targetDb = follower.update (pTarget->load(), own, n, (double) pSpeed->load(),
                                             (double) pMaxGain->load(), (double) pTrim->load(), pFreeze->load() > 0.5f);

    const double startDb = lastGainDb;
    float peak = 0.0f;
    for (int i = 0; i < n; ++i)
    {
        const double db = startDb + (targetDb - startDb) * ((i + 1.0) / n);
        const float g = (float) std::pow (10.0, db / 20.0);
        for (int c = 0; c < ch; ++c)
        {
            float& s = buffer.getWritePointer (c)[i];
            s *= g;
            peak = std::max (peak, std::abs (s));
        }
    }
    lastGainDb = targetDb;
    shownIn.store (own);
    shownGain.store ((float) targetDb);
    const float pk = juce::Decibels::gainToDecibels (peak, -100.0f);
    shownPeak.store (std::max (pk, shownPeak.load() - 0.5f)); // pico con caida lenta
}

juce::AudioProcessorEditor* GainStageProcessor::createEditor() { return new GainStageEditor (*this); }

void GainStageProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    if (auto xml = apvts.copyState().createXml()) copyXmlToBinary (*xml, dest);
}
void GainStageProcessor::setStateInformation (const void* data, int size)
{
    if (auto xml = getXmlFromBinary (data, size))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}
