#include "PluginProcessor.h"
#include "PluginEditor.h"

using APVTS = juce::AudioProcessorValueTreeState;

APVTS::ParameterLayout LevelMatchProcessor::createLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    p.push_back (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID { "mode", 1 }, "Modo",
                 juce::StringArray { "Referencia (antes)", "Igualar (despues)" }, 1));
    p.push_back (std::make_unique<juce::AudioParameterInt> (juce::ParameterID { "group", 1 }, "Grupo", 1, mg::kGroups, 1));
    p.push_back (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { "speed", 1 }, "Velocidad (s)",
                 juce::NormalisableRange<float> (0.2f, 10.0f, 0.01f, 0.5f), 2.0f));
    p.push_back (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { "maxgain", 1 }, "Ganancia maxima (dB)",
                 juce::NormalisableRange<float> (6.0f, 40.0f, 0.1f), 24.0f));
    p.push_back (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { "trim", 1 }, "Ajuste fino (dB)",
                 juce::NormalisableRange<float> (-12.0f, 12.0f, 0.1f), 0.0f));
    p.push_back (std::make_unique<juce::AudioParameterBool> (juce::ParameterID { "freeze", 1 }, "Congelar", false));
    return { p.begin(), p.end() };
}

LevelMatchProcessor::LevelMatchProcessor()
    : AudioProcessor (BusesProperties().withInput ("Input", juce::AudioChannelSet::stereo(), true)
                                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "STATE", createLayout())
{
    pMode = apvts.getRawParameterValue ("mode");
    pGroup = apvts.getRawParameterValue ("group");
    pSpeed = apvts.getRawParameterValue ("speed");
    pMaxGain = apvts.getRawParameterValue ("maxgain");
    pTrim = apvts.getRawParameterValue ("trim");
    pFreeze = apvts.getRawParameterValue ("freeze");
}

LevelMatchProcessor::~LevelMatchProcessor() { releaseGroup(); }

void LevelMatchProcessor::releaseGroup()
{
    if (publishedGroup >= 0)
        mg::sharedReference()[(size_t) publishedGroup].store (mg::kNoLevel);
    publishedGroup = -1;
}

bool LevelMatchProcessor::isBusesLayoutSupported (const BusesLayout& l) const
{
    const auto& in = l.getMainInputChannelSet();
    const auto& out = l.getMainOutputChannelSet();
    return in == out && (in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo());
}

void LevelMatchProcessor::prepareToPlay (double sr, int)
{
    meter.prepare (sr, 1.5);
    follower.prepare (sr);
    lastGainDb = 0.0;
}

void LevelMatchProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples();
    const int ch = buffer.getNumChannels();
    if (n == 0) return;

    const bool referenceMode = (int) pMode->load() == 0;
    const int group = juce::jlimit (1, mg::kGroups, (int) pGroup->load()) - 1;
    auto& reg = mg::sharedReference();

    // Mide la señal que ENTRA en esta instancia (antes de tocarla).
    const float own = meter.process (buffer.getArrayOfReadPointers(), ch, n);

    if (referenceMode)
    {
        if (publishedGroup != group)
        {
            releaseGroup();
            publishedGroup = group;
        }
        reg[(size_t) group].store (own);
        shownOwn.store (own);
        shownRef.store (own);
        shownGain.store (0.0f);
        return; // pasa el audio sin cambios
    }

    releaseGroup(); // una instancia en modo "Igualar" no publica nada

    const float ref = reg[(size_t) group].load();
    const double targetDb = follower.update (ref, own, n, (double) pSpeed->load(), (double) pMaxGain->load(),
                                             (double) pTrim->load(), pFreeze->load() > 0.5f);

    // Rampa lineal (en dB) a lo largo del bloque para evitar clics.
    const double startDb = lastGainDb;
    for (int i = 0; i < n; ++i)
    {
        const double db = startDb + (targetDb - startDb) * ((i + 1.0) / n);
        const float g = (float) std::pow (10.0, db / 20.0);
        for (int c = 0; c < ch; ++c)
            buffer.getWritePointer (c)[i] *= g;
    }
    lastGainDb = targetDb;

    shownRef.store (ref);
    shownOwn.store (own);
    shownGain.store ((float) targetDb);
}

juce::AudioProcessorEditor* LevelMatchProcessor::createEditor() { return new LevelMatchEditor (*this); }

void LevelMatchProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    if (auto xml = apvts.copyState().createXml())
        copyXmlToBinary (*xml, dest);
}

void LevelMatchProcessor::setStateInformation (const void* data, int size)
{
    if (auto xml = getXmlFromBinary (data, size))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new LevelMatchProcessor(); }
