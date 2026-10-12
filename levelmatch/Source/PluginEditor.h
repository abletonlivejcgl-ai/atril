#pragma once
#include <juce_audio_utils/juce_audio_utils.h>
#include "PluginProcessor.h"

class LevelMatchEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit LevelMatchEditor (LevelMatchProcessor&);
    ~LevelMatchEditor() override = default;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void updateVisibility();

    LevelMatchProcessor& proc;
    juce::ComboBox mode, group;
    juce::Slider speed, maxGain, trim;
    juce::ToggleButton freeze { "Congelar ganancia" };
    juce::Label modeL { {}, "Modo" }, groupL { {}, "Grupo" }, speedL { {}, "Velocidad (s)" },
                maxL { {}, "Max. dB" }, trimL { {}, "Ajuste fino" }, info;

    juce::AudioProcessorValueTreeState::ComboBoxAttachment modeA, groupA;
    juce::AudioProcessorValueTreeState::SliderAttachment speedA, maxA, trimA;
    juce::AudioProcessorValueTreeState::ButtonAttachment freezeA;
};
