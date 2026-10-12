#include "PluginEditor.h"

static void setupRotary (juce::Slider& s, const juce::String& suffix)
{
    s.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    s.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 80, 18);
    s.setTextValueSuffix (suffix);
}

LevelMatchEditor::LevelMatchEditor (LevelMatchProcessor& p)
    : AudioProcessorEditor (&p), proc (p),
      modeA (p.apvts, "mode", mode), groupA (p.apvts, "group", group),
      speedA (p.apvts, "speed", speed), maxA (p.apvts, "maxgain", maxGain), trimA (p.apvts, "trim", trim),
      freezeA (p.apvts, "freeze", freeze)
{
    mode.addItem ("Referencia (poner ANTES)", 1);
    mode.addItem ("Igualar (poner DESPUES)", 2);
    for (int i = 1; i <= mg::kGroups; ++i) group.addItem ("Grupo " + juce::String (i), i);
    setupRotary (speed, " s"); setupRotary (maxGain, " dB"); setupRotary (trim, " dB");

    for (auto* l : { &modeL, &groupL, &speedL, &maxL, &trimL })
    { l->setJustificationType (juce::Justification::centred); addAndMakeVisible (*l); }
    info.setJustificationType (juce::Justification::centred);
    info.setFont (juce::FontOptions (15.0f));
    for (auto* c : std::initializer_list<juce::Component*> { &mode, &group, &speed, &maxGain, &trim, &freeze, &info })
        addAndMakeVisible (*c);

    mode.onChange = [this] { updateVisibility(); };
    updateVisibility();
    setSize (460, 300);
    startTimerHz (10);
}

void LevelMatchEditor::updateVisibility()
{
    const bool match = mode.getSelectedId() == 2;
    for (auto* c : std::initializer_list<juce::Component*> { &speed, &maxGain, &trim, &freeze, &speedL, &maxL, &trimL })
        c->setVisible (match);
    resized();
}

void LevelMatchEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff1c1f26));
    g.setColour (juce::Colours::white);
    g.setFont (juce::FontOptions (20.0f, juce::Font::bold));
    g.drawText ("Level Match", 12, 8, getWidth() - 24, 26, juce::Justification::centredLeft);
}

void LevelMatchEditor::resized()
{
    auto r = getLocalBounds().reduced (12);
    r.removeFromTop (30);
    auto top = r.removeFromTop (46);
    auto a = top.removeFromLeft (top.getWidth() * 2 / 3).reduced (4, 0);
    modeL.setBounds (a.removeFromTop (16)); mode.setBounds (a.removeFromTop (26));
    top.reduce (4, 0);
    groupL.setBounds (top.removeFromTop (16)); group.setBounds (top.removeFromTop (26));

    r.removeFromTop (6);
    info.setBounds (r.removeFromBottom (44));
    if (mode.getSelectedId() == 2)
    {
        freeze.setBounds (r.removeFromBottom (24));
        const int w = r.getWidth() / 3;
        auto place = [&](juce::Label& l, juce::Slider& s) {
            auto c = r.removeFromLeft (w);
            l.setBounds (c.removeFromTop (16)); s.setBounds (c);
        };
        place (speedL, speed); place (maxL, maxGain); place (trimL, trim);
    }
}

void LevelMatchEditor::timerCallback()
{
    auto fmt = [](float v) { return v <= mg::kNoLevel + 1 ? juce::String ("--") : juce::String (v, 1) + " LUFS"; };
    if (mode.getSelectedId() == 1)
        info.setText ("Midiendo la entrada: " + fmt (proc.shownOwn.load()), juce::dontSendNotification);
    else
        info.setText ("Referencia: " + fmt (proc.shownRef.load()) + "    Entrada: " + fmt (proc.shownOwn.load())
                      + "\nGanancia aplicada: " + juce::String (proc.shownGain.load(), 1) + " dB",
                      juce::dontSendNotification);
}
