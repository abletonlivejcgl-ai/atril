#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "LoudnessMatcher.h"

class GainStageProcessor : public juce::AudioProcessor
{
public:
    GainStageProcessor();
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return "Gain Stage"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    juce::AudioProcessorValueTreeState apvts;
    std::atomic<float> shownIn { mg::kNoLevel }, shownGain { 0.0f }, shownPeak { -100.0f };

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    mg::LoudnessMeter meter;
    mg::GainFollower follower;
    double lastGainDb = 0.0;
    bool lastWeighted = true;
    std::atomic<float> *pTarget, *pMode, *pSpeed, *pMaxGain, *pTrim, *pFreeze;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GainStageProcessor)
};
