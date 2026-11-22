# Dokumentation veröffentlichen

## Entscheidung: GitHub Pages mit Jekyll

Die Dokumentation bleibt normales Markdown im Repository. Jekyll ist für diese
kleine Referenz ausreichend: keine zusätzliche JavaScript-Toolchain, kein zweites
Lockfile, keine duplizierten Inhalte. Ein eigenes responsives Layout liefert
Navigation, lesbare Codeblöcke und Hell-/Dunkelmodus. Astro/Starlight wäre eine
Option bei Bedarf an Suche, Versionierung oder einer größeren Informationsstruktur.

## Einmalige Einrichtung

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Actions und Deployments zur Umgebung `github-pages` erlauben; ggf. Branch-
   Protection/Environment-Regeln für `main` konfigurieren.
3. Workflow **Documentation** auf `main` manuell starten oder Docs nach `main` pushen.
4. Deployment-URL: `https://klab365.github.io/factory-pi/`.

Der Workflow baut Pull Requests, veröffentlicht aber nur `main`. Deploy benötigt
`pages: write` und `id-token: write`; keine PATs oder Provider-Credentials nötig.
Ein erster Lauf muss nach der Einrichtung erfolgreich deployen, bevor die URL verfügbar ist.

## Dateien und Pfade

- `docs/_config.yml`: Titel, `url`, `baseurl`; bei Fork/Repository-Umbenennung anpassen.
- `docs/_layouts/default.html`: gemeinsames Layout; Navigation nutzt `relative_url`.
- `docs/index.md`: Website-Einstieg; README bleibt der GitHub-Einstieg.
- Seiten benötigen Frontmatter mit `layout: default` und `title`.
- Relative Markdown-Links zwischen Seiten werden von GitHub Pages für HTML angepasst.
- Liquid-Ausdrücke (`{{ ... }}`) nicht in Beispiele einfügen, ohne sie mit
  Jekyll-`raw`/`endraw` zu schützen. Factory-Ausdrücke `${{ ... }}` sind ebenfalls betroffen.

## Prüfen

Der PR-Workflow baut mit `actions/jekyll-build-pages`, derselben Build-Umgebung
wie das Deployment. Optional mit Docker lokal aus dem Repository-Root:

```sh
docker run --rm -v "$PWD:/srv/jekyll" \
  -e GITHUB_WORKSPACE=/srv/jekyll -e INPUT_SOURCE=docs \
  -e INPUT_DESTINATION=_site -e GITHUB_REPOSITORY=klab365/factory-pi \
  ghcr.io/actions/jekyll-build-pages:v1.0.13
```

Der Container-Build benötigt Netzwerk für das Image. `_site/` ist generiert und
soll nicht committet werden. Für reine Markdown-Änderungen außerdem Links und
Syntaxbeispiele prüfen; `factory validate` prüft Beispiele ohne Modellaufrufe.
Ein lokaler Build beweist nicht, dass Pages im Repository freigeschaltet ist.
