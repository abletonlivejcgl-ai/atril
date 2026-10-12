#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "Drum808.h"

class Synth808Processor : public juce::AudioProcessor
{
public:
    Synth808Processor();
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return "Synth 808"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 1.5; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    juce::AudioProcessorValueTreeState apvts;

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    d808::Engine engine;
    std::atomic<float> *pKickTune, *pKickDecay, *pSnareTone, *pSnareSnap, *pTomTune, *pOhDecay, *pMaster;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Synth808Processor)
};
