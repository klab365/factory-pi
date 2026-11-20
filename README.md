# Pi Software Factory (prototype)

Pipelines liegen unter `.factory/pipelines/` und enthalten Shell-Schritte (`run`) oder Pi-Durable-Agent-Schritte (`agent` + `task`). Agent-Instruktionen liegen unter `.factory/agents/` als Markdown mit YAML-Frontmatter (`name`, `description`, `model`, `thinking`, `tools`). Agents laufen als Conversations im pi-durable-Harness und verwenden die Coding-Tools des Harness.

## Voraussetzungen

```sh
mise install
```

Der Agent-Provider muss in Pis `auth.json` eingerichtet sein (standardmäßig `~/.pi/agent/auth.json`; `PI_CODING_AGENT_DIR` kann den Pfad ändern). Der Durable-Runner liest und aktualisiert diese Credentials. Shell-Schritte führen YAML-Kommandos mit `bash -lc` im Projektverzeichnis aus – Pipelines daher nur aus vertrauenswürdigen Quellen aus.

## CI

Der Workflow `.github/workflows/ci.yml` führt bei Pull Requests und Pushes auf `main` die lokalen Checks mit `mise run check` aus. `mise install` installiert die in `mise.toml` festgelegte Bun-Version und führt den `postinstall`-Hook aus, der Dependencies via `bun install --frozen-lockfile` aus `bun.lock` installiert. Bei Dependency-Updates `bun install` ausführen und die aktualisierte `bun.lock` mit einchecken.

## Verwenden

```sh
# Lokale Checks:
mise run check
# Formatierung automatisch anwenden:
mise run format
# Diese Repository-Factory mit einem eigenen Ziel beauftragen:
mise run factory run software-factory --goal="Implementiere X und ergänze passende Tests"
```

`software-factory` (`.factory/pipelines/software-factory.yml`) ist die Arbeits-Pipeline für dieses Repository. Builder und Reviewer liefern ein strukturiertes `<factory-result>` mit Status und Feedback. Die YAML-Übergänge routen `completed` zum Review, `changes_requested` zurück zum Builder und `approved` zum Ende; `maxVisits` begrenzt Überarbeitungsschleifen. Ein Fehler stoppt die Pipeline.

Die Mise-Tasks `format`, `check-format`, `lint`, `tests`, `typecheck`, `validate` und `check` sind auch einzeln ausführbar; `check` bündelt alle Prüfungen. Pi Durable speichert Workflow- und Step-Checkpoints als JSONL in `.factory/state/durable`; ein beim Abbruch offener Lauf wird beim nächsten Start fortgesetzt. Bereits als erfolgreich gespeicherte Schritte werden übersprungen. Da ein Prozess zwischen externer Nebenwirkung und Checkpoint abstürzen kann, sind Shell-Schritte im Zweifel **at-least-once** und sollten idempotent sein. Es gibt noch keine Parallelität oder automatische Trigger-Ausführung.

Pipelines definieren ihre Felder unter `inputs:`. Pflichtfelder werden interaktiv abgefragt; nicht-interaktive Aufrufe können sie mit `--feld=value` übergeben. In `run`- und `task`-Texten werden Werte mit `${{ inputs.feld }}` eingesetzt. Beispiel: `.factory/pipelines/software-factory.yml` verwendet `inputs.goal`; Agent-Instruktionen liegen unter `.factory/agents/`.

Zusätzlich zu diesen statusgesteuerten Pipeline-Übergängen können Agents andere Agents direkt über pi-durable-Handoff-Tools beauftragen. Die erlaubten Ziele leiten sich aus `transitions` ab; nicht deklarierte Handoffs sind nicht als Tool verfügbar. Jeder Handoff läuft als Child-Conversation/Task und wird im JSONL-Journal unter `.factory/state/durable` persistiert.
