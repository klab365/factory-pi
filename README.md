# Pi Software Factory (prototype)

Pipelines liegen unter `.factory/pipelines/` und enthalten Shell-Schritte (`shell`) oder Pi-Durable-Agent-Schritte (`agent` + `task`). Agent-Instruktionen liegen unter `.factory/agents/` als Markdown mit YAML-Frontmatter (`name`, `description`, `model`, `thinking`, `tools`, optional `skills`). Agents laufen als Conversations im pi-durable-Harness und verwenden die Coding-Tools des Harness.

## Voraussetzungen

```sh
mise install
```

Der Agent-Provider muss in Pis `auth.json` eingerichtet sein (standardmäßig `~/.pi/agent/auth.json`; `PI_CODING_AGENT_DIR` kann den Pfad ändern). Der Durable-Runner liest und aktualisiert diese Credentials. Shell-Schritte führen YAML-Kommandos mit `bash -lc` im Projektverzeichnis aus – Pipelines daher nur aus vertrauenswürdigen Quellen aus.

## CI

Der Workflow `.github/workflows/ci.yml` führt bei Pull Requests und Pushes auf `main` die lokalen Checks mit `mise run check` aus. `mise install` installiert die in `mise.toml` festgelegten Bun- und Python-Versionen und führt den `postinstall`-Hook aus, der Dependencies via `bun install --frozen-lockfile` aus `bun.lock` installiert. Bei Dependency-Updates `bun install` ausführen und die aktualisierte `bun.lock` mit einchecken.

## Verwenden

```sh
# Lokale Checks:
mise run check
# Formatierung automatisch anwenden:
mise run format
# Diese Repository-Factory mit einem eigenen Ziel beauftragen:
mise run factory run software-factory --goal="Implementiere X und ergänze passende Tests"
```

`software-factory` (`.factory/pipelines/software-factory.yml`) ist die Arbeits-Pipeline für dieses Repository. Builder und Reviewer liefern ein strukturiertes `<factory-result>` mit Status und Feedback. Nach `completed` geht es zum Review. `changes_requested` vom Reviewer führt direkt zurück zum Builder, `approved` zur menschlichen Abnahme. Dort startet `approved` die Veröffentlichung; `rejected` beendet den Lauf ohne Veröffentlichung. Bei `change_requested` fragt die Pipeline nach Freitext und schickt ihn zusammen mit dem letzten Reviewer-Feedback an den Builder zurück. Danach folgen erneut Review und Abnahme; `maxVisits` begrenzt die Schleife. Ein Fehler stoppt die Pipeline.

Die Mise-Tasks `format`, `check-format`, `lint`, `tests`, `typecheck`, `validate` und `check` sind auch einzeln ausführbar; `check` bündelt alle Prüfungen. Pi Durable speichert Workflow- und Step-Checkpoints als JSONL in `.factory/state/durable`; ein beim Abbruch offener Lauf wird beim nächsten Start fortgesetzt. Jeder neue Lauf erhält eine eigene frische Run-Conversation für Ergebnisse, Cursor und Checkpoints. Zusätzlich erhält jeder Agent pro Lauf eine eigene Conversation: Erneute Besuche desselben Agents verwenden dieselbe Historie, unterschiedliche Agents bleiben strikt getrennt. Der Orchestrator übergibt nur strukturierte Ergebnisse/Feedback über die Task-Templates; das Arbeitsverzeichnis bleibt gemeinsam. Die Zuordnung von `runId` zu Run-Conversation und von `(runId, agentName)` zu Agent-Conversation wird jeweils atomar mit der Conversation gespeichert. Beim Resume werden exakt diese Conversations wieder geöffnet; ein fehlender Conversation-Datensatz ist ein Fehler und wird nicht durch eine neue Session ersetzt. Bereits vor dieser Trennung gestartete Läufe werden weiterhin in ihrer ursprünglichen Root-Conversation fortgesetzt, einschließlich vorhandener Handoffs; neue Läufe verwenden diese nie. Bereits vor der Agent-Trennung zugelassene Aufrufe werden anhand ihrer Request-ID in der Run-Conversation wiedergefunden und ohne erneute Konfiguration oder doppelte Ausführung abgeschlossen; erst neue Aufrufe wechseln in die isolierte Agent-Conversation. Bereits als erfolgreich gespeicherte Schritte werden übersprungen. Da ein Prozess zwischen externer Nebenwirkung und Checkpoint abstürzen kann, sind Shell-Schritte im Zweifel **at-least-once** und sollten idempotent sein. Es gibt noch keine Parallelität oder automatische Trigger-Ausführung.

Pipelines definieren ihre Felder unter `inputs:`. Pflichtfelder werden interaktiv abgefragt; nicht-interaktive Aufrufe können sie mit `--feld=value` übergeben. In `shell`- und `task`-Texten werden Werte mit `${{ inputs.feld }}` eingesetzt. Beispiel: `.factory/pipelines/software-factory.yml` verwendet `inputs.goal`; Agent-Instruktionen liegen unter `.factory/agents/`.

Nach der menschlichen Freigabe committet `publish` alle Git-Änderungen im Worktree und pusht den aktuellen Branch ohne Force-Push nach `origin`. Deshalb in einem separaten Branch mit einem anfangs sauberen Worktree arbeiten. Der Schritt führt `scripts/publish-pr.py` mit `python3` aus (nur Standardbibliothek) und benötigt authentifiziertes `gh`, Git-Push-Rechte und ein GitHub-Repository als `origin`; auf dem Default-Branch oder mit detached HEAD bricht er ab. Der Reviewer liefert `prTitle`, `prSummary` und `prVerification`; die Abnahme zeigt diese Metadaten vor der Veröffentlichung. Der kurze englische Titel ist zugleich der Commit-Betreff. Bei einem neuen PR formatiert `publish` die Beschreibung mit `## Summary` und `## Verification` und fügt für Issue-URLs aus dem Ziel, die auf dasselbe Repository verweisen, `Closes #…` ein. Fehlende Metadaten stoppen den Publisher vor dem Commit; ältere Läufe ohne diese Felder brauchen vor der Veröffentlichung ein neues Review. Ein existierender offener PR erhält durch den Push die neuen Commits, behält aber Titel und Beschreibung; andernfalls wird ein PR gegen den Default-Branch erstellt. Nach einem Fehler kann der Lauf fortgesetzt werden: Ein schon erstellter Commit und ein schon geöffneter PR werden wiederverwendet, solange Branch und Worktree unverändert bleiben.

Shell-Schritte verwenden `shell:` (die alte `run:`-Syntax wird nicht mehr akzeptiert). Für einfache Schritte kann der Wert ein Kommando-String sein; konfigurierbare Schritte verwenden ein Objekt:

```yaml
- id: build
  shell:
    command: bun run build
    workingDirectory: packages/app # relativ zum Projekt-Root; Standard: .
    env:
      BUILD_MODE: production
    timeout: 120000 # Millisekunden
    outputs: {stdout: true, stderr: false}
```

`env` überschreibt/ergänzt die Prozessumgebung. `outputs.stdout` und `outputs.stderr` speichern die jeweiligen, am Ende getrimmten Streams sowie `exitCode` im dauerhaften Step-Ergebnis; ausgewählte Werte stehen später als `${{ steps.build.stdout }}` bzw. `${{ steps.build.stderr }}` zur Verfügung. Nicht ausgewählte Streams werden weiterhin angezeigt, aber nicht persistiert. Bei Timeout beendet der Runner die Shell samt Nachfahren. Shell-Seiteneffekte sind **at-least-once**: Bei Abbruch zwischen Seiteneffekt und durablem Checkpoint kann ein Kommando erneut laufen; externe Aktionen sollten idempotent sein.

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
  Ohne ID werden nur abgeschlossene Läufe des aktuellen Worktrees angeboten; ein
  einzelner Treffer wird direkt gewählt. Die Auswahl zeigt Ziel, Pipeline, Zeit und ID.
  Neue Pi-Läufe speichern kanonische Repository- (Git-Common-Dir) und Worktree-Pfade,
  außerhalb von Git den kanonischen Arbeitsordner. Symlinks und Git-Unterordner
  werden normalisiert; nach Verschieben eines Checkouts gilt er als anderer Workspace.
  Alte Katalogeinträge ohne Identität bleiben ohne ID ausgeblendet, sind aber mit
  expliziter ID nutzbar. IDs mit bekannter fremder Worktree-Identität werden abgelehnt;
  dafür Pi im ursprünglichen Worktree öffnen. `resume` bleibt unverändert.
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

## Agent-Skills

Agents wählen wiederverwendbare Anweisungen explizit im YAML-Frontmatter:

```yaml
---
name: builder
skills:
  - typescript-expert
# alternativ: skills: [typescript-expert]
---
Agent-spezifische Anweisungen …
```

Ein Name wird ausschließlich relativ zum Projektverzeichnis als
`.agents/skills/<name>/SKILL.md` aufgelöst. Es gibt keine globale Suche, keinen
Fallback, keine automatischen Skills und keine Pfad-/URL-Referenzen. Namen bestehen
aus kleingeschriebenen ASCII-Buchstaben/Ziffern mit einzelnen Bindestrichen zwischen
Segmenten (maximal 64 Zeichen). Symlinks dürfen nicht aus dem Projekt herausführen.
Fehlendes `skills` oder `skills: []` lädt nichts; `null`, andere Feldtypen,
ungültige Namen und doppelte Referenzen sind Fehler.

Jede `SKILL.md` benötigt YAML-Frontmatter mit `name` (identisch zum Verzeichnisnamen)
und einer nicht leeren `description` sowie einen nicht leeren Markdown-Anweisungstext:

```markdown
---
name: typescript-expert
description: Sichere TypeScript-Implementierung und Tests
---
Prüfe externe Eingaben vor ihrer Verwendung.
```

`validate` und der Run-Preflight prüfen alle referenzierten Skills aller
Pipeline-Agents, bevor ein Journal geöffnet oder ein Schritt ausgeführt wird.
Nicht ausgewählte Skills werden weder gelesen noch validiert. Der Runner hängt
nur die ausgewählten Anweisungstexte in Listenreihenfolge mit Name, Beschreibung
und projektrelativem Quellpfad an die Agent-Instruktionen an, vor dem Factory-
Ergebnisprotokoll. Weitere Dateien/Links in Skills werden nicht automatisch geladen.
Skills erteilen keine Tools oder Handoff-Rechte und sind wie Agent-Instruktionen
vertrauenswürdige Projektkonfiguration, keine Sandbox.

Die Definitionen werden pro Runtime geladen, ohne globale Skill-Caches oder
zusätzliche History-Nachrichten. Normale Agent-Aufrufe und neue Handoff-Children
verwenden dieselbe agentenspezifische Konfiguration; die bestehende Trennung der
Agent-/Run-Conversations bleibt erhalten. Bereits zugelassene Requests werden beim
Replay nicht neu konfiguriert; neue Aufrufe verwenden die aktuell geladenen Skills.
Die aktuellen Dateien müssen auch beim Resume den Preflight bestehen.

### Mitgelieferte Skills und Quellen

| Skill | Agent | Zweck |
| --- | --- | --- |
| `typescript-expert` | Builder | Sichere TypeScript-Implementierung und deterministische Bun-Tests |
| `systematic-debugging` | Builder | Reproduktion, Ursachenanalyse und gezielte Regressionstests bei Fehlern |
| `code-review` | Reviewer | Konkrete Korrektheits-, Sicherheits- und Regressionsprüfung |
| `verification-before-completion` | Builder, Reviewer | Aktuelle Prüfergebnisse statt unbelegter Abschlussbehauptungen |

Die beiden zusätzlichen Workflow-Skills wurden nach Web-Recherche gezielt ausgewählt:
Fehlersuche ist bei CLI-/Prozess-/Journal-Grenzen besonders hilfreich; belastbare
Abschlussprüfungen werden sowohl bei Implementierung als auch Review benötigt.
Als Referenzen wurden die vollständigen Skills
[Systematic Debugging](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/systematic-debugging/SKILL.md)
und [Verification Before Completion](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/verification-before-completion/SKILL.md)
aus `obra/superpowers` gelesen. Die lokalen Texte sind eigenständig formulierte,
kompakte Factory-spezifische Checklisten, keine unveränderten Imports. Sie setzen
keine externen Skill-Loader, Zusatzdateien oder Superpowers-Tools voraus und
respektieren Read-only-Review, History-Isolation und die bestehenden Pipeline-Status.
Es werden keine entfernten Inhalte zur Laufzeit geladen.

Auch die bisherigen Texte sind eigenständig für Bun/Factory geschrieben. Als recherchierte Beispiele
für Skill-Struktur und fokussierte Checklisten dienten
[JavaScript/TypeScript Jest](https://github.com/github/awesome-copilot/blob/main/skills/javascript-typescript-jest/SKILL.md)
und [PostgreSQL Code Review](https://github.com/github/awesome-copilot/blob/main/skills/postgresql-code-review/SKILL.md)
aus GitHubs Awesome Copilot; deren framework-/datenbankspezifische Anweisungen werden
hier nicht übernommen.

### Human checkpoints

A step can use `human: {prompt: "Approve?", choices: [approved, rejected]}`
 instead of `run` or `agent`. Choices become the result `status`, suitable for
`transitions`; without choices, free text returns status `completed`. Results
also expose `response` and `summary` for `${{ steps.<id>.response }}`.

The CLI prompts on a terminal. Non-interactive runs stop at the durable checkpoint
with an error rather than guessing. Resume with `bun run factory run <pipeline>
--human-response=approved` (one pending response per invocation). Pi displays
`pending-input` and opens a selector or text input. Cancel or interrupt to leave
the checkpoint unanswered, then `/factory resume`. Invalid or missing responses
do not advance. Accepted responses are journaled as completed step results before
transitions or downstream work, and reused on replay; submissions are scoped to
the pending step/visit. As with shell steps generally, external shell side effects
must themselves be idempotent across process interruption.
