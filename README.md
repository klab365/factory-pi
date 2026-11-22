# Pi Software Factory

**Vom Ziel zur geprüften Änderung — mit wiederaufnehmbaren Agent-Pipelines.**

Factory verbindet Shell-Kommandos, spezialisierte Pi-Agents und menschliche
Freigaben in projektlokalen YAML-Pipelines. Ergebnisse und Fortschritt bleiben
im Durable-Journal erhalten; unterbrochene Arbeit lässt sich fortsetzen.

- **Projektlokal:** Pipelines, Agents und Skills werden mit deinem Code versioniert.
- **Kontrolliert:** explizite Statusübergänge, begrenzte Review-Schleifen und Human-Checkpoints.
- **Nachvollziehbar:** getrennte Agent-Historien und persistierte Step-Ergebnisse.
- **Flexibel:** Standalone-CLI oder interaktiv in Pi. Noch ein Prototyp, kein Sandbox-System.

## In zwei Minuten starten

Für einen lokalen Checkout benötigst du [Bun](https://bun.sh) (≥ 1.3) und `bash`.
Die getestete Toolchain lässt sich alternativ mit `mise install` einrichten.

```sh
git clone https://github.com/klab365/factory-pi.git
cd factory-pi
bun install --frozen-lockfile
bun link
cd /pfad/zu/deinem/projekt
factory init
factory run hello
```

`hello` ist eine Shell-Pipeline und braucht keine Credentials. `init` überschreibt
keine vorhandenen Dateien. Für Modellaufrufe konfigurierst du den Provider in
Pis `auth.json` (üblicherweise `~/.pi/agent/auth.json`).

Ohne Bun auf dem Zielsystem? Die [Installationsanleitung](docs/guide.md#installation-und-verwendung-in-anderen-repositories)
beschreibt Standalone-Binaries für Linux/macOS und npm/Pi-Installation.

## Eine Pipeline

`.factory/pipelines/check.yml`:

```yaml
name: Projekt prüfen
steps:
  - id: test
    shell: bun test
  - id: accept
    human:
      prompt: Ergebnis freigeben?
      choices: [approved, rejected]
    transitions:
      approved: end
      rejected: end
```

```sh
factory validate check
factory run check
```

Agents ergänzen Schritte um `agent: builder` und `task: ...`;
ihre Instruktionen stehen in `.factory/agents/builder.md`.
Die [Syntaxreferenz](docs/syntax.md) zeigt vollständige Beispiele.

## In Pi arbeiten

Nach Installation der Extension (`pi install npm:pi-software-factory`, sobald
veröffentlicht) im Zielprojekt:

```text
/factory run
/factory resume
/factory refine
```

`run` startet unabhängig, `resume` setzt unterbrochene Arbeit fort, `refine`
öffnet eine weitere Runde eines abgeschlossenen Laufs. Details und lokale
Extension-Entwicklung stehen im [Betriebshandbuch](docs/guide.md#factory-in-pi).

## Dokumentation

| Einstieg | Inhalt |
| --- | --- |
| [Syntax](docs/syntax.md) | Pipelines, Agents, Skills, Templates und Outputs |
| [Architektur](docs/architecture.md) | Ausführung, Zustandsmodell, Replay und Modulgrenzen |
| [Betrieb und Integration](docs/guide.md) | Installation, Pi, Credentials, Releases und Publishing |
| [Dokumentationswebsite](docs/deployment.md) | GitHub Pages einrichten und lokal prüfen |

## Entwicklung

```sh
bun install --frozen-lockfile
bun run check   # Format, Lint, Tests, TypeScript, Pipeline-Validierung
bun run build   # dist/factory für die aktuelle Plattform
```

Die mitgelieferte `software-factory`-Pipeline implementiert Ziele, lässt sie
reviewen und fragt vor dem Commit/Push nach menschlicher Freigabe.
**Nur in einem separaten Branch mit sauberem Worktree verwenden:** Der
Publishing-Schritt committet alle Änderungen und benötigt Git, Python und `gh`.

## Sicherheits- und Betriebsgrenzen

Pipelines und Agent-Instruktionen sind vertrauenswürdiger ausführbarer Projektcode.
Keine Sandbox, keine parallele Ausführung, keine automatischen Trigger.
Shell-Seiteneffekte können nach Abbruch wiederholt werden (**at-least-once**):
Kommandos idempotent gestalten. `.factory/state/` ist lokaler Laufzustand,
kein Quellcode; ausgewählte Outputs dürfen keine Secrets enthalten.
