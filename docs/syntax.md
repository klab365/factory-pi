---
layout: default
title: Syntaxreferenz
---
{% raw %}


# Syntax: Pipelines, Agents und Skills

Diese Referenz beschreibt die aktuelle Runner-Syntax, kein geplantes Schema.
Alle Pfade beziehen sich auf das aktuelle Zielprojekt. `factory validate <name>`
prüft eine Pipeline ohne Modellaufruf; vor jedem Lauf erfolgt ebenfalls ein Preflight.

## Dateistruktur

```text
.factory/
  pipelines/feature.yml
  agents/builder.md
  state/                   # lokal, nicht versionieren
.agents/
  skills/typescript-expert/SKILL.md
```

Der Dateiname ist der CLI-Schlüssel: `factory run feature`. Pipelines verwenden
`.yml`, Agents `.md`. Keine entfernten Konfigurationsquellen erforderlich.

## Vollständiges Agent-Beispiel

`.factory/pipelines/feature.yml`:

```yaml
name: Änderung mit Abnahme
inputs:
  goal:
    description: Was soll umgesetzt werden?
    required: true
steps:
  - id: implement
    agent: builder
    maxVisits: 3
    task: |-
      Implementiere: ${{ inputs.goal }}
      Bisheriges Feedback: ${{ steps.accept.response }}
    transitions:
      completed: accept
  - id: accept
    maxVisits: 3
    human:
      prompt: Änderung freigeben?
      choices: [approved, changes_requested, rejected]
    transitions:
      approved: end
      changes_requested: implement
      rejected: end
```

`.factory/agents/builder.md`:

```markdown
---
name: builder
description: Implementiert Änderungen mit Tests
model: openai-codex/gpt-6.1-sol
thinking: medium
tools: [read, bash, edit, write]
---
Lies zunächst die Projektanweisungen. Implementiere die Aufgabe und prüfe sie.
Berichte nur tatsächlich ausgeführte Checks.
```

Das Modell ist ein Beispiel aus der Repository-Konfiguration; verwende eine für
deinen Provider verfügbare Modell-ID und passende Credentials.

```sh
factory validate feature
factory run feature --goal="Ergänze Tests für den Parser"
```

## Pipeline-Felder

| Feld | Bedeutung |
| --- | --- |
| `name` | Lesbarer Name; CLI-Auswahl erfolgt über den Dateinamen |
| `inputs` | Map aus Input-Namen und Definitionen |
| `steps` | Nicht leere Liste; Start beim ersten Schritt |

Inputs unterstützen `description`, `required` (Standard: `true`), `default` und
`options` (Liste zulässiger Werte). Laufzeitwerte sind Strings. Nicht gesetzte
optionale Inputs ohne Default werden ausgelassen. Übergabe mit `--name=value`
oder `--name value`; fehlende Pflichtwerte werden am Terminal abgefragt,
ohne Terminal abgelehnt. Beispiel:

```yaml
inputs:
  mode:
    description: Prüfumfang
    default: quick
    options: [quick, full]
  note:
    required: false
```

Jeder Schritt benötigt eine eindeutige `id` und **genau eines** von `shell`,
`agent`, `human`. Optional: `name`, `outputs`, `transitions`, `maxVisits`.
`agent` benötigt zusätzlich `task`. `maxVisits` ist eine positive Ganzzahl,
standardmäßig **1**, und begrenzt Besuche je Runde.

Ohne `transitions` folgt der nächste Listeneintrag, beim letzten endet der Lauf.
Mit `transitions` muss der Ergebnisstatus einen Eintrag haben; ein fehlender
Eintrag ist ein Fehler. Ziel ist eine Step-ID oder das reservierte `end`.
Fehlgeschlagene Ausführung stoppt den Lauf, sie ist kein automatischer Fehlerzweig.
`run:` und `captureOutput:` sind entfernt und werden abgelehnt.

## Shell

```yaml
steps:
  - id: build
    shell:
      command: bun run build
      workingDirectory: packages/app
      env:
        BUILD_MODE: production
      timeout: 120000
      outputs: {stdout: true, stderr: false}
```

Alternativ `shell: bun test`. Ausführung mit `bash -lc`, standardmäßig im
Projekt-Root. `workingDirectory` wird relativ dazu aufgelöst; es ist keine
Sandbox-Grenze. `env` ergänzt/überschreibt die Prozessumgebung (Werte als Strings
angeben). `timeout` ist in Millisekunden und beendet auch Nachfahren.

Erfolgreiche Kommandos liefern `status: completed` und `exitCode: 0`.
Nicht-null Exit-Code, Timeout oder Output-Overflow stoppen die Ausführung.
Streams werden angezeigt, aber nur explizit ausgewählte Streams als getrimmte
`stdout`/`stderr` persistiert. Limit: zusammen 64 KiB UTF-8 für ausgewählte Streams.

## Human-Checkpoints

```yaml
steps:
  - id: approval
    human:
      prompt: Freigeben?
      choices: [approved, rejected]
    transitions:
      approved: end
      rejected: end
```

Mit `choices` wird die Auswahl zum `status`; ohne `choices` wird Freitext erfasst
und der Status ist `completed`. `response` und `summary` enthalten die Antwort.
CLI fragt am Terminal; Pi öffnet Auswahl oder Editor. Abbrechen lässt den
Checkpoint offen. Nicht-interaktiv wird ohne Antwort nicht fortgefahren:

```sh
factory run feature --human-response=approved
```

Das setzt den offenen CLI-Lauf mit einer Antwort fort (höchstens eine wartende
Antwort pro Aufruf). In Pi `/factory resume` verwenden. Akzeptierte Antworten
werden vor Folgeaktionen gespeichert und bei Replay wiederverwendet.

## Templates und Outputs

- `${{ inputs.goal }}`: Laufinput.
- `${{ steps.build.stdout }}`: direktes Ergebnisfeld.
- `${{ steps.build.outputs.report }}`: explizit deklariertes, typisiertes Output.

Templates funktionieren in `task`, Human-Prompts und Shell-Kommandos. In Shell-
Kommandos werden eingesetzte Werte gequotet; Werte werden nicht erneut als
Template ausgewertet. Sie sind Daten, keine nachzuladenden Shell-Fragmente.
Direkte Ergebnisreferenzen können in Feedback-Schleifen noch leer sein.
Typisierte Outputs haben dagegen statisch geprüfte Produzentenabhängigkeiten.

```yaml
steps:
  - id: build
    shell:
      command: 'printf "dist/report.json"'
      outputs: {stdout: true}
    outputs:
      report: {type: artifact, from: result.stdout}
      exit: {type: number, from: result.exitCode}
  - id: consume
    shell: 'cat ${{ steps.build.outputs.report }}'
```

Der Produzent muss die referenzierte Datei selbst erstellen; das Beispiel zeigt
nur die Pfadübergabe. `outputs.<name>` benötigt `type` (`string`, `number`,
`boolean`, `artifact`) und `from: result.<field>`. Verschachtelte Agent-Felder
sind möglich. Keine Typumwandlung: fehlende oder falsche Werte lassen den Schritt
scheitern. Benannte Output-Produzenten müssen auf jedem Pfad zum Konsumenten
abgeschlossen sein; Vorwärts-/Selbstreferenzen und bedingtes Umgehen sind ungültig.

`artifact` ist ein nicht leerer relativer Pfad ohne `..`, kein Upload oder Snapshot.
Dateien selbst aufbewahren. Jedes JSON-kodierte Output hat ein 64-KiB-Limit.
Outputs werden mit dem Abschluss gespeichert und bei Resume nicht neu berechnet;
Refine erzeugt sie für die neue Runde erneut. **Keine Secrets auswählen.**

## Agent-Frontmatter und Ergebnisprotokoll

| Feld | Vertrag |
| --- | --- |
| `name` | Erforderlich, muss dem Dateinamen ohne `.md` entsprechen |
| `description` | Optionale Beschreibung |
| `model` | Optional, `provider/model-id` |
| `thinking` | Optional: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | Optionale Liste der Tool-Namen; z. B. `read`, `bash`, `edit`, `write` |
| `skills` | Optionale Liste projektlokaler Skill-Namen |

Ohne Tool-Liste stehen die registrierten Tools zur Verfügung; eine Liste filtert
Coding-Tools. Erlaubte Handoff-Tools werden zusätzlich aus Übergängen abgeleitet.
Ein leeres `tools: []` ist keine Sandbox. Nach dem Frontmatter folgen Markdown-
Instruktionen; der Runner ergänzt Skills und das Ergebnisprotokoll.

Jeder Agent-Turn endet mit einem strukturierten Block:

```text
<factory-result>{"status":"completed","summary":"Änderung umgesetzt","feedback":""}</factory-result>
```

Statuswerte stammen aus den Step-Transitions (ohne Transitions: `completed`).
Zusätzliche JSON-Felder können von späteren Tasks oder Output-Mappings genutzt
werden. Statusübergänge routen den nächsten Pipeline-Schritt; direkte Handoffs
sind separate Child-Tasks und kein Ersatz für diese Ablaufsteuerung.

## Skills

Optional im Agent-Frontmatter: `skills: [typescript-expert]`.
Auflösung ausschließlich als `.agents/skills/<name>/SKILL.md`:

```markdown
---
name: typescript-expert
description: Sichere TypeScript-Änderungen
---
Validiere externe Eingaben. Ergänze deterministische Tests.
```

Namen: kleingeschriebene ASCII-Buchstaben/Ziffern, einzelne Bindestriche zwischen
Segmenten, maximal 64 Zeichen. Keine Duplikate, Pfade, URLs oder globalen Fallbacks.
Frontmatter-Name muss zum Verzeichnis passen; Beschreibung und Anweisungstext
müssen nicht leer sein. Symlinks dürfen nicht aus dem Projekt führen.

Fehlendes `skills` oder `[]` lädt nichts; `null` ist ungültig. Preflight prüft alle
referenzierten Skills, auch beim Resume. Anweisungen werden in Listenreihenfolge
angehängt, nicht referenzierte Dateien nicht geladen. Skills erteilen keine Tools
oder Handoff-Rechte. Bereits zugelassene Requests werden beim Replay nicht neu
konfiguriert; neue Requests verwenden die aktuellen Definitionen.

{% endraw %}
