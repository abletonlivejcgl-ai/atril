#include "Synth808Processor.h"

using APVTS = juce::AudioProcessorValueTreeState;

static std::unique_ptr<juce::RangedAudioParameter> fp (const char* id, const char* name, float lo, float hi, float def, float skew = 1.0f)
{
    return std::make_unique<juce::AudioParameterFloat> (juce::ParameterID { id, 1 }, name,
                                                        juce::NormalisableRange<float> (lo, hi, 0.01f, skew), def);
}

APVTS::ParameterLayout Synth808Processor::createLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    p.push_back (fp ("kicktune", "Bombo - Afinacion (st)", -12.0f, 12.0f, 0.0f));
    p.push_back (fp ("kickdecay", "Bombo - Duracion (s)", 0.15f, 2.0f, 0.8f, 0.6f));
    p.push_back (fp ("snaretone", "Caja - Tono", 0.0f, 1.0f, 0.5f));
    p.push_back (fp ("snaresnap", "Caja - Snappy", 0.0f, 1.0f, 0.5f));
    p.push_back (fp ("tomtune", "Toms - Afinacion (st)", -12.0f, 12.0f, 0.0f));
    p.push_back (fp ("ohdecay", "Hi-hat abierto - Duracion (s)", 0.08f, 1.2f, 0.35f, 0.6f));
    p.push_back (fp ("master", "Volumen", 0.0f, 1.5f, 0.8f));
    return { p.begin(), p.end() };
}

Synth808Processor::Synth808Processor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "STATE", createLayout())
{
    pKickTune = apvts.getRawParameterValue ("kicktune");
    pKickDecay = apvts.getRawParameterValue ("kickdecay");
    pSnareTone = apvts.getRawParameterValue ("snaretone");
    pSnareSnap = apvts.getRawParameterValue ("snaresnap");
    pTomTune = apvts.getRawParameterValue ("tomtune");
    pOhDecay = apvts.getRawParameterValue ("ohdecay");
    pMaster = apvts.getRawParameterValue ("master");
}

bool Synth808Processor::isBusesLayoutSupported (const BusesLayout& l) const
{
    return l.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}

void Synth808Processor::prepareToPlay (double sr, int) { engine.prepare (sr); }

void Synth808Processor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    d808::Params p;
    p.kickTune = pKickTune->load(); p.kickDecay = pKickDecay->load();
    p.snareTone = pSnareTone->load(); p.snareSnap = pSnareSnap->load();
    p.tomTune = pTomTune->load(); p.openHatDecay = pOhDecay->load(); p.master = pMaster->load();

    const int n = buffer.getNumSamples();
    auto* l = buffer.getWritePointer (0);
    auto* r = buffer.getNumChannels() > 1 ? buffer.getWritePointer (1) : nullptr;

    auto it = midi.begin();
    for (int i = 0; i < n; ++i)
    {
        while (it != midi.end() && (*it).samplePosition <= i)
        {
            const auto m = (*it).getMessage();
            if (m.isNoteOn()) engine.trigger (d808::Engine::voiceForNote (m.getNoteNumber()), m.getFloatVelocity());
            else if (m.isAllNotesOff() || m.isAllSoundOff()) engine.prepare (getSampleRate());
            ++it;
        }
        const float s = engine.process (p);
        l[i] = s;
        if (r) r[i] = s;
    }
}

juce::AudioProcessorEditor* Synth808Processor::createEditor() { return new juce::GenericAudioProcessorEditor (*this); }

void Synth808Processor::getStateInformation (juce::MemoryBlock& dest)
{
    if (auto xml = apvts.copyState().createXml()) copyXmlToBinary (*xml, dest);
}
void Synth808Processor::setStateInformation (const void* data, int size)
{
    if (auto xml = getXmlFromBinary (data, size))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new Synth808Processor(); }
