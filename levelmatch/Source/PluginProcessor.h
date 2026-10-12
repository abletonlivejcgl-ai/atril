#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "LoudnessMatcher.h"

class LevelMatchProcessor : public juce::AudioProcessor
{
public:
    LevelMatchProcessor();
    ~LevelMatchProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Level Match"; }
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

    // Para mostrar en pantalla
    std::atomic<float> shownRef { mg::kNoLevel }, shownOwn { mg::kNoLevel }, shownGain { 0.0f };

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    void releaseGroup();

    mg::LoudnessMeter meter;
    mg::GainFollower follower;
    double lastGainDb = 0.0;
    int publishedGroup = -1;

    std::atomic<float>* pMode = nullptr;
    std::atomic<float>* pGroup = nullptr;
    std::atomic<float>* pSpeed = nullptr;
    std::atomic<float>* pMaxGain = nullptr;
    std::atomic<float>* pTrim = nullptr;
    std::atomic<float>* pFreeze = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LevelMatchProcessor)
};
