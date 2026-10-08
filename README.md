# Atril

Repertorio, setlists y partituras para el escenario. Web app instalable en Android que funciona sin conexión.

- Importa partituras exportadas desde Sibelius en MusicXML (`.musicxml`, `.xml`, `.mxl`).
- Muestra la partitura y deja elegir qué partes ver.
- Setlists ordenables y modo escenario.
- Los datos se guardan en el dispositivo; el menú ⋯ permite exportar e importar copias de seguridad.

Las partituras se dibujan con [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) (BSD-3-Clause, ver `LICENSE-OpenSheetMusicDisplay.txt`).

## Sonido real

Si la partitura tiene instrumentos transpositores (trompeta en Sib, trompa en Fa, saxo…), aparece un interruptor **Sonido real**. Activado, cada parte se muestra tal como suena (sin transponer), útil para leerla desde el piano. Se recuerda entre sesiones.
