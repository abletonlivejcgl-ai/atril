# Level Match (VST3 / AU, macOS)

Iguala el volumen de salida al volumen que había ANTES de tus plugins.

## Uso
Un plugin que va detrás no puede ver lo que entró en el anterior, así que se usan dos instancias:
1. **Referencia**: ponla ANTES de los plugins que cambian el volumen. No toca el audio, solo lo mide.
2. **Igualar**: ponla AL FINAL de la cadena. Baja o sube el volumen hasta igualar a la Referencia.
Ambas deben tener el mismo **Grupo** (1-8; sirve para varias pistas a la vez).

Si pones la Referencia y "Igualar" en pistas distintas, funciona igual mientras el grupo coincida.
Mide en LUFS (ponderación K, ITU-R BS.1770), ignora silencios, y cambia despacio (parámetro Velocidad).

## Instalar en Mac
1. Descarga LevelMatch-macOS.zip y descomprímelo.
2. Copia `Level Match.vst3` a `~/Library/Audio/Plug-Ins/VST3/`
3. En Terminal: `xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/VST3/"Level Match.vst3"`
4. En Ableton: Preferencias > Plug-ins > activar VST3 y "Rescan".

## Compilar
`cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release`
(o con GitHub Actions: .github/workflows/build.yml)
