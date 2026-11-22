---
layout: default
title: Start
---
{% raw %}


# Vom Ziel zur geprüften Änderung

Pi Software Factory führt Shell-Kommandos, spezialisierte Agents und menschliche
Freigaben als wiederaufnehmbare YAML-Pipelines aus. Die Konfiguration bleibt im
Projekt; Ergebnisse und Agent-Historien liegen im lokalen Durable-Journal.

## Loslegen

Mit Bun und einem lokalen Checkout:

```sh
bun install --frozen-lockfile
bun link
cd /pfad/zu/deinem/projekt
factory init
factory run hello
```

Der Starter benötigt kein Modell. Für Agent-Schritte werden Pi-Provider-Credentials benötigt.

1. [Installation und Pi-Integration](guide.md) einrichten.
2. [Pipeline und Agent definieren](syntax.md).
3. [Ausführung und Replay verstehen](architecture.md).

**Vertrauensgrenze:** Factory ist keine Sandbox. Shell-Kommandos und Agent-Tools
arbeiten im Projekt. Seiteneffekte müssen wiederholbar sein; keine Secrets als
Outputs persistieren. Aktuell keine parallelen Schritte oder automatischen Trigger.

{% endraw %}
