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

Die Mise-Tasks `format`, `check-format`, `lint`, `tests`, `typecheck`, `validate` und `check` sind auch einzeln ausführbar; `check` bündelt alle Prüfungen. Pi Durable speichert Workflow- und Step-Checkpoints als JSONL in `.factory/state/durable`; ein beim Abbruch offener Lauf wird beim nächsten Start fortgesetzt. Jeder neue Lauf erhält eine eigene frische Run-Conversation für Ergebnisse, Cursor und Checkpoints. Zusätzlich erhält jeder Agent pro Lauf eine eigene Conversation: Erneute Besuche desselben Agents verwenden dieselbe Historie, unterschiedliche Agents bleiben strikt getrennt. Der Orchestrator übergibt nur strukturierte Ergebnisse/Feedback über die Task-Templates; das Arbeitsverzeichnis bleibt gemeinsam. Die Zuordnung von `runId` zu Run-Conversation und von `(runId, agentName)` zu Agent-Conversation wird jeweils atomar mit der Conversation gespeichert. Beim Resume werden exakt diese Conversations wieder geöffnet; ein fehlender Conversation-Datensatz ist ein Fehler und wird nicht durch eine neue Session ersetzt. Bereits vor dieser Trennung gestartete Läufe werden weiterhin in ihrer ursprünglichen Root-Conversation fortgesetzt, einschließlich vorhandener Handoffs; neue Läufe verwenden diese nie. Bereits vor der Agent-Trennung zugelassene Aufrufe werden anhand ihrer Request-ID in der Run-Conversation wiedergefunden und ohne erneute Konfiguration oder doppelte Ausführung abgeschlossen; erst neue Aufrufe wechseln in die isolierte Agent-Conversation. Bereits als erfolgreich gespeicherte Schritte werden übersprungen. Da ein Prozess zwischen externer Nebenwirkung und Checkpoint abstürzen kann, sind Shell-Schritte im Zweifel **at-least-once** und sollten idempotent sein. Es gibt noch keine Parallelität oder automatische Trigger-Ausführung.

Pipelines definieren ihre Felder unter `inputs:`. Pflichtfelder werden interaktiv abgefragt; nicht-interaktive Aufrufe können sie mit `--feld=value` übergeben. In `run`- und `task`-Texten werden Werte mit `${{ inputs.feld }}` eingesetzt. Beispiel: `.factory/pipelines/software-factory.yml` verwendet `inputs.goal`; Agent-Instruktionen liegen unter `.factory/agents/`.

Zusätzlich zu diesen statusgesteuerten Pipeline-Übergängen können Agents andere Agents direkt über pi-durable-Handoff-Tools beauftragen. Die erlaubten Ziele leiten sich aus `transitions` ab; nicht deklarierte Handoffs sind nicht als Tool verfügbar. Jeder Handoff läuft als Child-Conversation/Task und wird im JSONL-Journal unter `.factory/state/durable` persistiert.

## Factory in Pi

```sh
# Isoliertes Pi mit Factory-Extension (keine Änderung an ~/.pi/agent):
mise run dev-pi
# Lade-Smoke-Test ohne Modellaufruf:
mise run dev-pi -- --smoke
# Alternativ in normalem Pi explizit laden:
pi -e ./src/pi-extension.ts
```

In Pi:

- `/factory` oder `/factory run`: YAML-Pipeline auswählen und Inputs abfragen.
- `/factory run software-factory`: Pipeline direkt wählen; `goal` öffnet einen
  mehrzeiligen Editor. Esc bricht die Eingabe ab; Flags sind nicht erforderlich.
- `/factory resume [runId]`: unterbrochenen Lauf mit gespeicherten Inputs und exakt
  denselben Durable-Agent-Conversations fortsetzen. Ohne ID erscheint eine Auswahl
  unterbrochener Läufe; bei leerer Auswahl eine Fehlermeldung.
- `/factory refine [runId]`: abgeschlossenen Lauf auswählen, Zusatzanweisung im Editor
  eingeben und eine weitere Runde derselben Pipeline/Agent-Conversations starten.
  Visit-Limits gelten pro Runde. Unterbrochene Runden zuerst mit `resume` fortsetzen.
- Jedes neue `run` erzeugt eine unabhängige benannte Pi-Session und neue
  Builder-/Reviewer-Conversations, auch wenn ein anderer Lauf unterbrochen ist.

Die echte menschliche Ziel-Eingabe wird als User-Nachricht gespeichert (dadurch legt
Pi die Session-Datei an). Ein expliziter Kickoff über `pi.sendUserMessage` startet
einen echten Agent-Turn, der das registrierte Tool `factory_run` aufruft. Damit sehen
Session-Monitore aktive Agent-/Tool-Arbeit. Das Tool prüft Run-, Request- und native
Session-Zuordnung und streamt Fortschritt über `onUpdate`; gerenderte Custom-Entries
und Footer-Status bleiben zusätzlich erhalten. Die Timeline bleibt beim Wiederöffnen
sichtbar. Resume und Refine verwenden denselben Weg; Abbruch beendet den Prozessbaum
und lässt den ausstehenden Request für Resume gespeichert. Der Kickoff benötigt das
in Pi gewählte Modell (die Integrationstests verwenden einen lokalen Test-Provider). `.factory/state/pi-runs.json` ordnet
Run-IDs ihren Pi-Sessions zu; die Ausführung und ihre Checkpoints bleiben im vorhandenen
Durable-Journal. Vor dem Öffnen des Harness wird der Scheduler auf die ausgewählte
Run-Conversation, ihre gespeicherten Agent-Conversations und deren transitive
Handoff-Conversations eingeschränkt. Sowohl die Wiederaufnahme lebender Tasks als
auch die Zulassung wartender Inputs bleibt auf diesen Baum begrenzt; ein neuer Lauf
aktiviert keine unterbrochenen Tasks anderer Läufe im gemeinsamen Journal. Gespeicherte
IDs und Historien werden dabei nicht migriert oder ersetzt. Alte Root-Läufe bleiben
fortsetzbar; sind mehrere unterbrochene Legacy-Läufe derselben Root-Conversation
zugeordnet, wird die mehrdeutige Auswahl aus Sicherheitsgründen abgelehnt, statt
möglicherweise fremde Tasks zu starten. Neue unabhängige Läufe bleiben möglich.

Die Extension startet die bestehende CLI in einem Bun-Child-Prozess
mit JSON über stdin und JSONL-Events über stdout, ohne Shell-Interpolation von
Benutzereingaben. Shell-Schritte in vertrauenswürdigen YAML-Dateien bleiben ausführbar.
Während eines aktiven Laufs ist ein Sessionwechsel gesperrt; Pi-Shutdown beendet den
Runner unter POSIX in einer eigenen Prozessgruppe: zuerst SIGTERM, nach 300 ms
SIGKILL auch für verbleibende Nachkommen. Shutdown wartet auf diese Bereinigung;
dasselbe gilt bei Fehlern in der Event-Verarbeitung. Nach Prozessabbruch `resume` verwenden.

`dev-pi` verwendet ein temporäres Agent-Verzeichnis, eine Kopie von `auth.json` und
nur die explizite Factory-Extension; normale Extensions, MCP, Skills, Prompts, Themes
und projektlokale Konfiguration werden nicht geladen. OAuth-Updates betreffen nur die
Kopie. Der Smoke-Test kopiert keine Credentials und prüft per RPC `get_commands`, dass
`/factory` geladen ist; er sendet keinen Prompt und macht keinen Modellaufruf. Sessions liegen dauerhaft unter `.factory/state/pi-sessions`, damit spätere
Teststarts sie fortsetzen können. Das temporäre Verzeichnis wird beim Beenden gelöscht.
Dies isoliert die **Pi-Konfiguration**, nicht das Arbeitsverzeichnis: die Factory darf
weiterhin Projektdateien bearbeiten und YAML-Kommandos ausführen. Nicht mehrere
Factory-Pi-Prozesse gleichzeitig im selben Repository betreiben.
