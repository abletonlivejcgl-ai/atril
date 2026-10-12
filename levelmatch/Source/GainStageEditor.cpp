#include "GainStageEditor.h"

static void rotary (juce::Slider& s, const juce::String& suffix)
{
    s.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    s.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 80, 18);
    s.setTextValueSuffix (suffix);
}

GainStageEditor::GainStageEditor (GainStageProcessor& p)
    : AudioProcessorEditor (&p), proc (p),
      measureA (p.apvts, "measure", measure), targetA (p.apvts, "target", target), speedA (p.apvts, "speed", speed),
      maxA (p.apvts, "maxgain", maxGain), trimA (p.apvts, "trim", trim), freezeA (p.apvts, "freeze", freeze)
{
    measure.addItem ("RMS (dBFS)", 1);
    measure.addItem ("LUFS", 2);
    rotary (target, " dB"); rotary (speed, " s"); rotary (maxGain, " dB"); rotary (trim, " dB");
    for (auto* l : { &measureL, &targetL, &speedL, &maxL, &trimL })
    { l->setJustificationType (juce::Justification::centred); addAndMakeVisible (*l); }
    info.setJustificationType (juce::Justification::centred);
    info.setFont (juce::FontOptions (15.0f));
    for (auto* c : std::initializer_list<juce::Component*> { &measure, &target, &speed, &maxGain, &trim, &freeze, &info })
        addAndMakeVisible (*c);
    setSize (520, 310);
    startTimerHz (10);
}

void GainStageEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff1c1f26));
    g.setColour (juce::Colours::white);
    g.setFont (juce::FontOptions (20.0f, juce::Font::bold));
    g.drawText ("Gain Stage", 12, 8, getWidth() - 24, 26, juce::Justification::centredLeft);
}

void GainStageEditor::resized()
{
    auto r = getLocalBounds().reduced (12);
    r.removeFromTop (30);
    auto top = r.removeFromTop (46);
    measureL.setBounds (top.removeFromTop (16)); measure.setBounds (top.removeFromTop (26).removeFromLeft (200));
    r.removeFromTop (6);
    info.setBounds (r.removeFromBottom (44));
    freeze.setBounds (r.removeFromBottom (24));
    const int w = r.getWidth() / 4;
    auto place = [&](juce::Label& l, juce::Slider& s) { auto c = r.removeFromLeft (w); l.setBounds (c.removeFromTop (16)); s.setBounds (c); };
    place (targetL, target); place (speedL, speed); place (maxL, maxGain); place (trimL, trim);
}

void GainStageEditor::timerCallback()
{
    const float in = proc.shownIn.load();
    info.setText ("Entrada: " + (in <= mg::kNoLevel + 1 ? juce::String ("--") : juce::String (in, 1) + " dB")
                  + "    Ganancia: " + juce::String (proc.shownGain.load(), 1) + " dB"
                  + "\nPico de salida: " + juce::String (proc.shownPeak.load(), 1) + " dBFS",
                  juce::dontSendNotification);
}
