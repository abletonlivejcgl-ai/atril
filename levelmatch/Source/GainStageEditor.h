#pragma once
#include <juce_audio_utils/juce_audio_utils.h>
#include "GainStageProcessor.h"

class GainStageEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit GainStageEditor (GainStageProcessor&);
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    GainStageProcessor& proc;
    juce::ComboBox measure;
    juce::Slider target, speed, maxGain, trim;
    juce::ToggleButton freeze { "Congelar ganancia" };
    juce::Label measureL { {}, "Medicion" }, targetL { {}, "Objetivo" }, speedL { {}, "Velocidad" },
                maxL { {}, "Max. dB" }, trimL { {}, "Ajuste fino" }, info;
    juce::AudioProcessorValueTreeState::ComboBoxAttachment measureA;
    juce::AudioProcessorValueTreeState::SliderAttachment targetA, speedA, maxA, trimA;
    juce::AudioProcessorValueTreeState::ButtonAttachment freezeA;
};
