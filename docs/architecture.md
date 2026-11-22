---
layout: default
title: Architektur
---
{% raw %}


# Architektur

Factory ist ein sequenzieller, projektlokaler Pipeline-Runner auf dem
**Pi-Durable-Harness**. YAML beschreibt den Kontrollfluss, Markdown die Agent-
Instruktionen. Die CLI ist die Ausführungsgrenze; die Pi-Extension ist ein
interaktives Frontend, kein zweiter Runner.

## Systemübersicht

```text
Terminal                         Pi UI (/factory)
   │                                  │
   │                          pi-extension.ts / pi-session.ts
   │                                  │ JSON stdin / JSONL stdout
   └──────────────────────► cli.ts ◄───┘
                               │
                  Validierung + Input-Erfassung
                               │
                   sequenzieller Step-Dispatcher
                      /        |         \
               bash -lc    Agent-Turn   Human-Checkpoint
                               │
                        agent-runtime.ts
                               │
                       Pi Durable Harness
                               │
                  journal.ts + run-storage.ts
                               │
                  .factory/state/durable/*.jsonl
```

CLI, Extension und Runtime stammen aus dem installierten Paket; Konfiguration,
Arbeitsverzeichnis und Zustand stammen aus dem **aktuellen Zielprojekt**.
Es gibt keinen zentralen Factory-Server und keine Datenbank außerhalb des lokalen Journals.

## Module und Verantwortung

| Modul unter `src/` | Verantwortung |
| --- | --- |
| `cli.ts` | Commands, Preflight, Shell-Prozesse, Step-Dispatcher, Übergänge und Events |
| `pipeline-inputs.ts` | YAML laden, Pfade begrenzen, CLI-Inputs erfassen |
| `agent-runtime.ts` | Agent-Definitionen, Modell-/Tool-Konfiguration, Handoffs, Ergebnisparsing |
| `skills.ts` | Projektlokale Skills validieren und Instruktionen zusammensetzen |
| `human.ts` | Prompts und Antworten validieren |
| `step-outputs.ts` | Output-Deklarationen, Pfadabhängigkeiten und Laufzeittypen prüfen |
| `journal.ts` | Run-/Agent-Conversations, Cursor und Checkpoints speichern/rekonstruieren |
| `run-storage.ts` | Recovery und Input-Admission auf den ausgewählten Conversation-Baum begrenzen |
| `pi-extension.ts` | Pi-Kommandos, Session-Zuordnung, UI und Tool-Integration |
| `pi-session.ts` | Child-Prozess, Event-Protokoll und Prozessbereinigung |
| `pi-credentials.ts` | Provider-Credentials für den Harness |
| `init.ts` | Nicht destruktiver Projekt-Starter |
| `pi-test.ts` | Isoliertes Entwicklungs-Pi und Smoke-Test |

## Ein Lauf vom Input zum Ergebnis

1. Pipeline, Agents, ausgewählte Skills und Output-Referenzen werden geprüft,
   bevor Journal oder Steps geöffnet werden.
2. Der Runner wählt einen neuen oder fortzusetzenden Run. Der Storage-Scope wird
   **vor** `Harness.open` gesetzt, damit Recovery keine fremden Tasks aktiviert.
3. Inputs werden für neue Runs erfasst, für Resume aus dem Journal geladen.
4. Der Dispatcher führt den aktuellen Step/Visit aus oder verwendet dessen
   bereits gespeichertes erfolgreiches Ergebnis.
5. Shell liefert Prozessresultate, Agent liefert Factory-Result-JSON, Human liefert
   eine validierte Antwort. Output-Mappings werden an dieser Grenze geprüft.
6. Der Abschluss inklusive Outputs wird gespeichert, bevor der Status den nächsten
   Schritt auswählt. Cursor und Besuchszähler begrenzen Schleifen.
7. `end` beendet den Lauf. Fehler stoppen ihn; das Harness wird geschlossen.

## Persistenz und Isolation

| Identität | Zweck |
| --- | --- |
| `runId` | Unabhängiger Lauf mit eigenen Inputs und Ergebnissen |
| Run-Conversation | Cursor, Step-Checkpoints und Laufzustand |
| `(runId, agentName)` | Eigene Agent-Conversation mit Historie über wiederholte Besuche |
| Handoff-Child | Delegierter Task unterhalb der jeweiligen Conversation |
| Runde / Step / Visit | Unterscheidung von Refine-Runden und Schleifenbesuchen |
| Request-ID | Wiederfinden bereits zugelassener Agent-Aufrufe |

Neue Runs bekommen frische Run- und Agent-Conversations. Derselbe Agent behält
innerhalb eines Runs seine Historie; unterschiedliche Agents teilen keine
Conversation. Strukturierte Ergebnisse/Feedback werden über Templates weitergereicht.
**Das Dateisystem bleibt gemeinsam:** Conversation-Isolation ist keine Worktree-
oder Prozess-Sandbox.

Die Zuordnungen werden atomar mit den Conversations gespeichert. Resume öffnet
dieselben Datensätze; ein fehlender Datensatz ist ein Fehler, kein Anlass für eine
neue Session. Legacy-Runs behalten ihre ursprüngliche Root-Conversation und
bereits zugelassene Requests; keine automatische Migration oder Historienersetzung.
Mehrdeutige unterbrochene Legacy-Runs auf derselben Root werden sicher abgelehnt.

`run-storage.ts` begrenzt sowohl Wiederaufnahme lebender Tasks als auch Zulassung
wartender Inputs auf Run, Agent-Conversations und transitive Handoff-Children.
Nur nach Conversation zu filtern wäre unzureichend: der Harness-Scheduler arbeitet
ansonsten auf dem gesamten gemeinsamen Storage.

## Resume, Refine und Replay

- **Neuer Pi-Run:** unabhängige Pi-Session plus frische Durable-Conversations.
- **Resume:** offene Arbeit mit gespeicherten Inputs und denselben Conversations.
  Erfolgreiche Checkpoints werden übersprungen; offene Requests wiedergefunden.
- **Refine:** weitere Runde eines abgeschlossenen Runs mit Zusatzanweisung und
  vorhandener Agent-Historie. Besuchslimits und Outputs gelten neu pro Runde.
  Unterbrochene Runden erst per Resume abschließen.

CLI `factory run <name>` kann den offenen CLI-Lauf wiederaufnehmen; die Pi-
Integration unterscheidet die Modi explizit. `.factory/state/pi-runs.json`
verknüpft Run-IDs mit Pi-Sessions und Workspace-Identitäten; die eigentlichen
Checkpoints liegen im Durable-Journal. Git-Common-Dir und Worktree werden kanonisch
identifiziert; explizit fremde Worktree-IDs werden in Pi abgelehnt. Alte Einträge
ohne Identität bleiben mit expliziter ID nutzbar.

### Keine Exactly-once-Garantie für externe Effekte

Zwischen externer Aktion (Datei schreiben, API-Aufruf, Push) und dauerhaftem
Checkpoint kann der Prozess abstürzen. Ein Step kann dann erneut ausgeführt
werden: **at-least-once**. Externe Aktionen brauchen Idempotenz oder eigene
Deduplizierung. Gespeicherte Outputs sind Werte, keine Dateisnapshots. Ein
persistierter Artefaktpfad garantiert nicht, dass die Datei noch existiert.

## Pi-Prozessgrenze

Die Extension startet CLI oder `FACTORY_BIN` ohne Shell-Interpolation von
Benutzereingaben. Ein JSON-Request geht über stdin, JSONL-Events über stdout;
Logs laufen im Session-Modus über stderr. Events melden Fortschritt und wartende
Human-Eingaben. Antworten sind an den aktuellen Checkpoint gebunden.

Ein echter Pi-Agent-Turn ruft das registrierte `factory_run`-Tool auf; Run-,
Request- und native Session-Zuordnung werden geprüft. Dadurch sehen Monitore
aktive Tool-Arbeit und die Timeline bleibt nach Wiederöffnen erhalten. Der
Kickoff benötigt das in Pi gewählte Modell, auch wenn die Pipeline nur Shell nutzt.

Während eines aktiven Laufs ist Sessionwechsel gesperrt. Abbruch/Shutdown beendet
unter POSIX die Prozessgruppe zuerst mit SIGTERM und nach 300 ms mit SIGKILL,
auch bei Fehlern in der Event-Verarbeitung. Der offene Request bleibt für Resume.
Nicht mehrere Factory-Pi-Prozesse gleichzeitig im selben Repository betreiben.

## Vertrauen und Grenzen

YAML, Agent-Markdown und Skills sind vertrauenswürdige Projektkonfiguration.
Shell läuft mit der Benutzerumgebung; Agent-Tools dürfen Dateien verändern und
Kommandos ausführen. Skill-Pfadvalidierung und Tool-Listen schaffen keine Sandbox.
Credentials liegen standardmäßig in `~/.pi/agent/auth.json`; der Durable-Runner
kann sie aktualisieren. Outputs werden explizit ausgewählt, müssen aber trotzdem
auf Secrets geprüft werden.

Aktuell: sequenzielle Steps, keine automatische Trigger-Ausführung und keine
allgemeine Exactly-once-Garantie. Das repositoryeigene Publishing ist ein expliziter
Shell-Schritt nach Human-Freigabe, kein implizites Feature jedes Runs.

## Verifikation

`bun run check` bündelt Format, Lint, Bun-Tests, TypeScript und Validierung der
Repository-Pipeline. Lokale Tests verwenden deterministische Fixtures und
Test-Provider statt bezahlter Modellaufrufe. Der Pi-Smoke-Test prüft Extension-
Registrierung ohne Credentials oder Prompt. Das beweist keine Live-Provider-
Verfügbarkeit; diese bleibt eine separate Betriebsprüfung.

{% endraw %}
