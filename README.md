# Discord Lyrics Status (DSC Lyrics)

<p align="center">
  <a href="#polski">Wersja polska</a> • <a href="#english">English version</a>
</p>

---

<a name="polski"></a>
# Wersja polska

Samodzielna aplikacja dla systemu Windows, która odczytuje odtwarzanie ze Spotify za pomocą systemu Windows SMTC, pobiera zsynchronizowane teksty piosenek z LRCLIB i aktualizuje niestandardowy status na Discordzie w czasie rzeczywistym.

* **Działa na:** Windows 10 / Windows 11
* **Wymagania:** Node.js 18.17+ (lub spakowany plik `.exe` zawierający środowisko Node)
* **Koszt:** $0 — brak bota Discord, brak zdalnego serwisu, brak telemetrii
* **Bezpieczeństwo tokena:** przechowywany wyłącznie w `%APPDATA%\DiscordLyricsStatus\config.json`, nigdy nie jest logowany ani wysyłany nigdzie poza oficjalnym API Discorda.

---

## 🛠️ Poradnik krok po kroku: Jak uruchomić aplikację?

### Co zrobić przed odpaleniem (Wymagania wstępne)
1. **Zainstaluj Node.js** (wersja 18.17 lub nowsza) – pobierz go z oficjalnej strony [nodejs.org](https://nodejs.org/) i zainstaluj w systemie.
2. **Pobierz kod źródłowy projektu** – możesz użyć polecenia `git clone <twoj-fork>` lub pobrać repozytorium jako archiwum ZIP i je rozpakować.
3. Otwórz terminal (np. **PowerShell** lub Wiersz poleceń) i przejdź do katalogu z rozpakowanym projektem:
   ```powershell
   cd dsc-lyrics
   ```

### Jak odpalić aplikację (Instrukcja krok po kroku)
1. **Zainstaluj zależności:** Wpisz w terminalu poniższe polecenie, aby pobrać wymagane pakiety Node.js:
   ```powershell
   npm install
   ```
2. **Zbuduj aplikację:** Skompiluj kod projektu do wersji produkcyjnej, uruchamiając:
   ```powershell
   npm run build
   ```
3. **Uruchom program:** Wpisz polecenie startowe:
   ```powershell
   npm start
   ```
4. **Konfiguracja tokena (Pierwsze uruchomienie):** 
   * Przy pierwszym starcie aplikacja nie ma jeszcze zapisanego tokena, dlatego automatycznie otworzy w Twojej domyślnej przeglądarce prostą stronę konfiguracyjną.
   * Zostaniesz poproszony o podanie tokena użytkownika Discord. 
   * Po zatwierdzeniu token zostanie zweryfikowany i zapisany bezpiecznie w pliku `%APPDATA%\DiscordLyricsStatus\config.json`, a konfiguracja zostanie zamknięta.
   * Aplikacja uruchomi się ponownie i od tego momentu będzie w czasie rzeczywistym śledzić odtwarzaną muzykę ze Spotify i aktualizować Twój status na Discordzie!

---

## Co to robi

1. Monitoruje sesję **System Media Transport Controls** systemu Windows, którą publikuje Spotify. Brak odpytywania (pollingu) o stan transportu — aplikacja reaguje bezpośrednio na zdarzenia z systemu operacyjnego.
2. Gdy utwór zaczyna grać, wyszukuje zsynchronizowane teksty w [LRCLIB](https://lrclib.net). Wyniki są zapisywane w pamięci podręcznej na dysku (TTL 24h, kluczowane według utworu, wykonawcy i czasu trwania) oraz w pamięci operacyjnej (RAM).
3. Planuje przejścia między linijkami tekstu z dokładnością do milisekund, używając pojedynczego `setTimeout` odświeżanego z `Date.now()` przy każdym wywołaniu — brak opóźnień (driftu), brak odpytywania co milisekundę.
4. Przesyła bieżącą linijkę do niestandardowego statusu na Discordzie poprzez endpoint `/users/@me/settings`, korzystając z kolejki sekwencyjnej uwzględniającej nagłówek `Retry-After` oraz deduplikującej identyczne aktualizacje.

Jeśli tekst utworu jest niedostępny, aplikacja wyświetla format **Wykonawca — Tytuł** zamiast linijki tekstu. Jeśli Spotify zostanie zamknięte, status jest czyszczony. W przypadku odrzucenia tokena przez Discorda (błędy 401/403), automatycznie ponawiany jest proces konfiguracji w przeglądarce.

---

## Szybki start (dla deweloperów)

```powershell
git clone <your fork>
cd dsc-lyrics
npm install
npm run build
npm start
```

### Przydatne polecenia

| Polecenie          | Działanie                                                             |
| ------------------ | --------------------------------------------------------------------- |
| `npm start`        | Uruchamia zbudowaną paczkę (`dist/main.cjs`).                         |
| `npm run dev`      | Buduje przy zapisie + uruchamia ze `src/` z mapami źródłowymi (source maps). |
| `npm run lint`     | Uruchamia ESLint dla `src/**/*.js`.                                   |
| `npm run build`    | Tworzy pakiety ESM + CJS w katalogu `dist/`.                          |
| `npm run verify`   | Sprawdzenia post-build: istnienie, rozmiary, `node --check`, test dymny. |
| `npm run package`  | Tworzy jedno-plikowy plik `.exe` dla Windows za pomocą SEA w `release/`. |
| `npm run clean`    | Usuwa `dist/`, `release/` oraz pamięć podręczną logów.                  |

### Zmienne środowiskowe

| Zmienna           | Działanie                                                             |
| ----------------- | --------------------------------------------------------------------- |
| `DLS_ADAPTER=mock`| Pomija całkowicie SMTC; używa wbudowanego adaptera mock (do testów / CI). |
| `DLS_LOG=debug`   | Szczegółowe logowanie (verbose).                                      |
| `APPDATA`         | Nadpisuje katalog konfiguracyjny dla danego użytkownika.              |

---

## Architektura

```
                  ┌──────────────────────────┐
                  │  Windows SMTC (Spotify)  │
                  └────────────┬─────────────┘
                               │ zdarzenia
                               ▼
        ┌──────────────────────────────────────────────┐
        │         src/scripts/smtc-bridge.ps1           │
        │   (PowerShell 5 / 7, strumieniuje JSON na stdout) │
        └────────────────────┬─────────────────────────┘
                             │ JSON linii tekstu
                             ▼
              ┌───────────────────────────────┐
              │ PowerShellBridgeAdapter       │   ← kontrakt wtyczki adaptera
              └────────────┬──────────────────┘
                           │ zdarzenia: attached, detached,
                           │   playbackStatus, timeline,
                           │   mediaProperties, error
                           ▼
                ┌──────────────────────────┐
                │       SmtcService        │   ← deduplikacja zdarzeń, backoff,
                └────────────┬─────────────┘     wykrywanie pauzy/wznawiania/przewijania
                             │
                  ┌──────────┴──────────┐
                  │ trackchange         │ pozycja
                  ▼                     ▼
       ┌──────────────────┐   ┌──────────────────┐
       │  LyricsProvider  │   │    Scheduler     │
       │  LRCLIB + cache  │   │ bazujący na setTimeout │
       └─────────┬────────┘   │ bez opóźnień     │
                 │ linijki    └────────┬─────────┘
                 ▼                    │ linijka
       ┌──────────────────────────────────────┐
       │            StateManager               │   ← pojedyncze źródło prawdy
       └────────────────┬─────────────────────┘
                        │ tekst statusu
                        ▼
              ┌────────────────────────┐
              │     DiscordClient      │   ← kolejka sekwencyjna, Retry-After,
              │   PATCH @me/settings   │     deduplikacja, ponowne połączenie, brak logowania tokena
              └────────────────────────┘
                        │ HTTPS
                        ▼
                ┌──────────────────┐
                │  Discord API v9  │
                └──────────────────┘
```

Każdy prostokąt odpowiada modułowi znajdującemu się w katalogu `src/`. Powiązania wstrzykiwania zależności (DI) znajdują się w `src/main.js` — w całym środowisku wykonawczym **nie ma globalnego stanu mutowalnego**.

### Kluczowe moduły

| Moduł                                             | Odpowiedzialność                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.js`                                     | Wejście do procesu: instalacja obsługi błędów, blokada instancji, podpięcie DI, obsługa sygnałów systemowych.                                       |
| `src/core/state-manager.js`                       | Orkiestrator. Reaguje na zdarzenia SMTC, inicjuje wyszukiwanie tekstów, steruje harmonogramem i klientem Discord.                                  |
| `src/core/logger.js`                              | Ustrukturyzowany logger (JSON) z rotacją, ujściem do pliku, lustrzanym odbiciem na stderr oraz **maskowaniem tokenów** w każdym polu i wiadomości.     |
| `src/core/config.js`                              | Magazyn konfiguracyjny z zapisem atomowym. Waliduje każde pole za pomocą dedykowanych walidatorów. Kwarantanna uszkodzonych plików. Migracja v1 → v2. |
| `src/core/paths.js`                               | Rozwiązuje ścieżki `%APPDATA%`, `%LOCALAPPDATA%`, PowerShell oraz cmd.exe — nigdy nie ufa zmiennej PATH.                                             |
| `src/core/browser.js`                             | Wieloplatformowe "otwórz URL w domyślnej przeglądarce" przez PowerShell w Windows, `open` na macOS, `xdg-open` na Linuxie. Nigdy nie wywołuje `spawn('cmd', …)`. |
| `src/core/single-instance.js`                     | Blokada pojedynczej instancji za pomocą pliku blokady otwartego z flagą `wx`; odrzuca drugie uruchomienie.                                           |
| `src/services/playback-adapter.js`                | Kontrakt (interfejs) adaptera.                                                                                                                       |
| `src/services/smtc-service.js`                    | Tłumaczy zdarzenia adaptera na `trackchange` / `statechange` / `position`. Łączy duplikaty. Ponawia próby w przypadku błędów.                         |
| `src/services/powershell-bridge-adapter.js`       | Uruchamia `smtc-bridge.ps1`, sparsowuje JSON linii, przekazuje dalej jako zdarzenia adaptera.                                                         |
| `src/services/mock-adapter.js`                    | Skryptowany adapter testowy dla celów programistycznych bez użycia Spotify.                                                                         |
| `src/scripts/smtc-bridge.ps1`                     | Strona PowerShell: odpytuje `GlobalSystemMediaTransportControlsSessionManager` i emituje JSON. Działa na PowerShell 5 oraz 7.                        |
| `src/services/lrc-parser.js`                      | Parser LRC → `[{ms, text}]`. Obsługuje znaczniki BOM, CRLF, linie z wieloma znacznikami, ułamki milisekund, nieposortowane dane, linie wadliwe, znaczniki metadanych. |
| `src/services/lyrics-provider.js`                 | Klient LRCLIB. Pamięć podręczna L1 (RAM) + L2 (Dysk) + TTL + wykładniczy backoff + anulowanie przez `AbortController`. Nigdy nie wyrzuca błędu przy nieudanym zapytaniu. |
| `src/services/scheduler.js`                       | Pojedynczy `setTimeout` odświeżany z `Date.now()` przy każdym wywołaniu. Obsługuje pauzę, wznowienie, przewijanie, ponowne uruchomienie utworu i pętlę. |
| `src/services/discord-client.js`                  | Sekwencyjna kolejka żądań PATCH. Respektuje `Retry-After`. Deduplikuje identyczne kolejne aktualizacje. Ponawia połączenie przy błędach sieci. Nigdy nie loguje tokena. |
| `src/setup/setup-server.js`                       | Prosty serwer `http`: auto-port, token CSRF, walidacja formatu tokena, jednorazowa konsumpcja, otwiera przeglądarkę przez `core/browser.js`.             |

---

## Gwarancje niezawodności

Środowisko wykonawcze opiera się na niezmiennikach, które kod egzekwuje w każdym miejscu:

1. **Brak nieobsłużonych odrzuceń obietnic (unhandled promise rejections).** Główny program obsługi `unhandledRejection` wypisuje stos wywołań i kontynuuje działanie; `uncaughtException` wypisuje stos i kończy proces (system operacyjny lub menedżer uruchamiania decyduje o ponownym starcie).
2. **Brak wycieków timerów.** Każdy `setTimeout` i `setInterval` jest parowany z `clearTimeout` / `clearInterval` w pasującej ścieżce `stop()`, a wszystkie posiadają wywołanie `.unref()`, dzięki czemu nigdy nie blokują zakończenia procesu.
3. **Brak zduplikowanych aktualizacji statusu.** Klient Discorda porównuje każdą nową wartość z ostatnio wysłaną jeszcze przed dodaniem do kolejki.
4. **Brak zduplikowanych harmonogramów tekstów.** Harmonogram to pojedyncza klasa z jednym timerem; w środowisku wykonawczym istnieje dokładnie jedna instancja.
5. **Brak powtórzonych zapytań do LRCLIB.** Pamięć podręczna L1 + L2 dostawcy omija powtórzone wyszukiwania dla tej samej trójki `(track, artist, durationBucket)` w oknie TTL.
6. **Brak porzuconych odczytów SMTC.** Proces pomostowy jest automatycznie restartowany w przypadku wyjścia, a `SmtcService` podpina się ponownie przy zdarzeniach `attached`.
7. **Brak tokena w logach.** Logger redaguje każde pole, którego klucz zawiera `token` / `authorization`, oraz każdy ciąg znaków pasujący kształtem do tokena Discorda.

---

## Bezpieczeństwo

* Token użytkownika Discord jest przechowywany jako czysty tekst w pliku `%APPDATA%\DiscordLyricsStatus\config.json`. Jest to celowe — token jest **tokenem użytkownika**, posiadającym uprawnienia tożsame z hasłem, i NIE MOŻE opuszczać maszyny. Nie logujemy go, nie przesyłamy nigdzie poza `discord.com/api/v9` i nie szyfrujemy (ponieważ Windows DPAPI powiązałoby instalację z profilem użytkownika i uniemożliwiło przenośność). Jeśli komputer zostanie skompromitowany na poziomie użytkownika, token i tak jest już zagrożony, niezależnie od szyfrowania.
* Serwer konfiguracyjny nasłuchuje **wyłącznie** na adresie `127.0.0.1`. Nie można się do niego dostać z innej maszyny.
* Wymagany jest token CSRF przy zapytaniu `/submit`.
* Format tokena jest weryfikowany po stronie serwera przed zapisem; wadliwy token nigdy nie trafia do pliku konfiguracyjnego.
* Wszystkie parametry zapytań LRCLIB są kodowane URL (URL-encoded); dane wejściowe użytkownika nigdy nie są bezpośrednio interpolowane do ścieżek.

---

## Kompatybilność z systemem Windows

Środowisko wykonawcze było testowane na:

* Windows 10 + PowerShell 5.1 (domyślny `powershell.exe`)
* Windows 11 + PowerShell 7 (`pwsh.exe`)
* Środowiskach z powłokami `cmd.exe` oraz PowerShell
* Okrojonych środowiskach, w których w zmiennej `%PATH%` brakuje `cmd.exe` lub `powershell.exe`

Aplikacja nigdy nie wywołuje `spawn('cmd', …)` bez uprzedniego odnalezienia konkretnej ścieżki. Plik `cmd.exe` wyszukiwany jest poprzez `ComSpec`, `WINDIR\System32\cmd.exe` oraz `WINDIR\Sysnative\cmd.exe`. PowerShell jest lokalizowany za pomocą jawnych ścieżek `Program Files\PowerShell \pwsh.exe` oraz `System32\WindowsPowerShell 1.0\powershell.exe`.

Skrypt pomostowy PowerShell wykorzystuje przestrzeń nazw `[Windows.Media.Control.*]`, która jest częścią środowiska uruchomieniowego Universal Windows Platform dostępnego w każdej wspieranej wersji systemu Windows od wersji 1607. Aplikacja nie wymaga instalacji żadnych zewnętrznych modułów PowerShell.

---

## Proces budowania (Pipeline)

* `scripts/build.mjs` generuje dwa pakiety w katalogu `dist/`:
  * `dist/main.mjs` — ESM, używany bezpośrednio przez `node` w trakcie prac rozwojowych.
  * `dist/main.cjs` — CommonJS, używany przez paker SEA oraz polecenie `npm start`.
* Pakiet CommonJS zawiera plik `dist/package.json` z wpisem `"type": "commonjs"`, dzięki czemu Node paruje go poprawnie bez zmiany nazwy.
* `scripts/package.mjs` wywołuje wbudowany w Node mechanizm Single Executable Application (`--experimental-sea-config`), wklejając pakiet do kopii `node.exe` przy użyciu biblioteki `postject`.
* Jeśli SEA jest niedostępna na hoście Node, paker przełącza się na launcher przenośny (`discord-lyrics-status.exe` to `node.exe` + `main.cjs` + skrypt `.bat`). Działa to także bez zainstalowanego środowiska Node na komputerze docelowym, ponieważ `node.exe` jest dołączony w pakiecie.

Czas zimnego startu zdominowany jest przez ładowanie przez system operacyjny pliku `node.exe`; sam pakiet ma rozmiar ~42 KiB i parsuje się w dziesiątkach milisekund.

---

## Konfiguracja — odnośnik

Przechowywana w pliku `%APPDATA%\DiscordLyricsStatus\config.json`.

```jsonc
{
  "version": 2,
  "discord": {
    "token": "<twoj_token_uzytkownika_discord>",
    "userId": null
  },
  "display": {
    "showArtist": true,
    "maxLineLength": 120,
    "separator": " — "
  },
  "lyrics": {
    "provider": "lrclib",
    "timeoutMs": 8000,
    "maxRetries": 4,
    "cacheTtlMs": 86400000
  },
  "scheduler": {
    "tickMs": 100,
    "lookaheadMs": 4000
  },
  "logging": {
    "level": "info",
    "verbose": false
  },
  "setup": { "lastPort": null }
}
```

Magazyn konfiguracyjny waliduje każde pole podczas ładowania i zapisu. Nieznane klucze są po cichu odrzucane. Uszkodzone pliki są przenoszone do `config.corrupt-<timestamp>.json`, a środowisko uruchamia się z domyślnymi ustawieniami.

---

## Licencja

MIT — zobacz plik `LICENSE`.

---

<a name="english"></a>
# English version

A standalone Windows app that reads Spotify playback through Windows
SMTC, fetches synchronized lyrics from LRCLIB, and updates your
Discord custom status in real time.

* **Runs on:** Windows 10 / Windows 11
* **Requires:** Node.js 18.17+ (or a packaged .exe that ships Node)
* **Cost:** $0 — no Discord bot, no remote service, no telemetry
* **Token safety:** stored only in `%APPDATA%\DiscordLyricsStatus\config.json`, never logged, never sent anywhere except Discord's API

---

## 🛠️ Step-by-Step Tutorial: How to Run the App

### What to do before running (Prerequisites)
1. **Install Node.js** (version 18.17 or higher) – download and install it from the official website [nodejs.org](https://nodejs.org/).
2. **Download or clone the source code** – use `git clone <your-fork>` or download the repository as a ZIP archive and extract it.
3. Open your terminal (e.g., **PowerShell** or Command Prompt) and navigate to the extracted project directory:
   ```powershell
   cd dsc-lyrics
   ```

### How to run the app (Step-by-step instructions)
1. **Install dependencies:** Run the following command in your terminal to install the required Node.js packages:
   ```powershell
   npm install
   ```
2. **Build the application:** Compile the project code for production by running:
   ```powershell
   npm run build
   ```
3. **Start the program:** Run the startup command:
   ```powershell
   npm start
   ```
4. **Token Setup (First Launch):**
   * On the first launch, since no token is configured yet, the app will automatically open a tiny setup page in your default browser.
   * You will be asked to enter your Discord user token.
   * Once submitted, the token will be validated and safely saved to `%APPDATA%\DiscordLyricsStatus\config.json`, and the setup server will close.
   * The app will then start tracking Spotify playback and updating your custom status on Discord in real time!

---

## What it does

1. Watches the Windows **System Media Transport Controls** session that
   Spotify publishes. No polling for transport state — it reacts to events
   from the OS.
2. When a track starts playing, looks up synced lyrics from
   [LRCLIB](https://lrclib.net). Results are cached on disk (24h TTL,
   keyed by track+artist+duration) and in memory.
3. Schedules lyric transitions with millisecond accuracy using a single
   `setTimeout` that re-anchors from `Date.now()` on every fire — no
   drift, no per-millisecond polling.
4. Pushes the current line to your Discord custom status via the
   `/users/@me/settings` endpoint, with a sequential request queue that
   honors `Retry-After` and deduplicates identical updates.

If lyrics are unavailable for a song, it shows **Artist — Title** instead
of the lyric line. If Spotify closes, the status is cleared. If Discord
rejects the token (401/403), it re-opens the browser setup flow.

---

## Quick start (developer)

```powershell
git clone <your fork>
cd dsc-lyrics
npm install
npm run build
npm start
```

### Useful commands

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `npm start`        | Run the built bundle (`dist/main.cjs`).                              |
| `npm run dev`      | Build on save + run from `src/` with source maps.                    |
| `npm run lint`     | ESLint over `src/**/*.js`.                                           |
| `npm run build`    | Produce ESM + CJS bundles in `dist/`.                                |
| `npm run verify`   | Post-build checks: existence, sizes, `node --check`, smoke.          |
| `npm run package`  | SEA-pack a single-file Windows `.exe` in `release/`.                 |
| `npm run clean`    | Remove `dist/`, `release/`, and log cache.                           |

### Environment variables

| Variable          | Effect                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `DLS_ADAPTER=mock`| Skip SMTC entirely; use the in-process mock adapter (for tests / CI). |
| `DLS_LOG=debug`   | Verbose logging.                                                      |
| `APPDATA`         | Override the per-user config directory.                               |

---

## Architecture

```
                  ┌──────────────────────────┐
                  │  Windows SMTC (Spotify)  │
                  └────────────┬─────────────┘
                               │ events
                               ▼
        ┌──────────────────────────────────────────────┐
        │         src/scripts/smtc-bridge.ps1           │
        │   (PowerShell 5 / 7, streams JSON on stdout)  │
        └────────────────────┬─────────────────────────┘
                             │ line-delimited JSON
                             ▼
              ┌───────────────────────────────┐
              │ PowerShellBridgeAdapter       │   ← pluggable adapter contract
              └────────────┬──────────────────┘
                           │ events: attached, detached,
                           │   playbackStatus, timeline,
                           │   mediaProperties, error
                           ▼
                ┌──────────────────────────┐
                │       SmtcService        │   ← event dedup, backoff,
                └────────────┬─────────────┘     pause/resume/seek detection
                             │
                  ┌──────────┴──────────┐
                  │ trackchange         │ position
                  ▼                     ▼
       ┌──────────────────┐   ┌──────────────────┐
       │  LyricsProvider  │   │    Scheduler     │
       │  LRCLIB + cache  │   │ setTimeout-based │
       └─────────┬────────┘   │ drift-free       │
                 │ lines      └────────┬─────────┘
                 ▼                    │ line
       ┌────────────────----------------──────┐
       │            StateManager               │   ← single source of truth
       └────────────────┬─────────────────────┘
                        │ status text
                        ▼
              ┌────────────────────────┐
              │     DiscordClient      │   ← sequential queue, Retry-After,
              │   PATCH @me/settings   │     dedup, reconnect, no token logs
              └────────────────────────┘
                        │ HTTPS
                        ▼
                ┌──────────────────┐
                │  Discord API v9  │
                └──────────────────┘
```

Every box has a corresponding module under `src/`. The DI wiring lives
in `src/main.js` — there is **no global mutable state** anywhere in the
runtime.

### Key modules

| Module                                            | Responsibility                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.js`                                     | Process entry: install error handlers, lock, wire DI, handle signals.                                                                                |
| `src/core/state-manager.js`                       | The orchestrator. Reacts to SMTC events, drives lyrics lookups, drives the scheduler, drives the Discord client.                                     |
| `src/core/logger.js`                              | Structured (JSON) logger with rotation, file sink, stderr mirror, **token scrubbing** on every field and message string.                            |
| `src/core/config.js`                              | Atomic-write config store. Validates every field with field-level validators. Quarantines corrupt files. Migrates v1 → v2.                          |
| `src/core/paths.js`                               | Resolves `%APPDATA%`, `%LOCALAPPDATA%`, PowerShell, and cmd.exe — never trusts PATH.                                                                 |
| `src/core/browser.js`                             | Cross-platform "open URL in default browser" via PowerShell on Windows, `open` on macOS, `xdg-open` on Linux. Never `spawn('cmd', …)`.              |
| `src/core/single-instance.js`                     | One-instance lock using a `wx`-opened lockfile; refuses a second launch.                                                                             |
| `src/services/playback-adapter.js`                | The adapter contract (interface).                                                                                                                    |
| `src/services/smtc-service.js`                    | Translates adapter events into `trackchange` / `statechange` / `position`. Coalesces duplicates. Retries on failure.                                 |
| `src/services/powershell-bridge-adapter.js`       | Spawns `smtc-bridge.ps1`, parses line-delimited JSON, re-emits as adapter events.                                                                   |
| `src/services/mock-adapter.js`                    | A scripted fake for tests and dev without Spotify.                                                                                                   |
| `src/scripts/smtc-bridge.ps1`                     | The PowerShell side: queries `GlobalSystemMediaTransportControlsSessionManager` and emits JSON. Works on PowerShell 5 and 7.                          |
| `src/services/lrc-parser.js`                      | LRC → `[{ms, text}]`. Handles BOMs, CRLF, multi-stamp lines, fractional ms, unsorted input, malformed lines, metadata tags.                          |
| `src/services/lyrics-provider.js`                 | LRCLIB client. Memory L1 cache + disk L2 cache + TTL + exponential backoff + `AbortController` cancellation. Never throws on lookup failure.       |
| `src/services/scheduler.js`                       | Single `setTimeout` re-anchored from `Date.now()` on every fire. Handles pause, resume, seek, track restart, track repeat.                          |
| `src/services/discord-client.js`                  | Sequential PATCH queue. Honors `Retry-After`. Dedupes identical consecutive updates. Reconnects on network failure. Never logs the token.          |
| `src/setup/setup-server.js`                       | Tiny `http` server: auto-port, CSRF token, token format validation, one-shot consumption, opens browser via `core/browser.js`.                      |

---

## Reliability guarantees

The runtime is built around a few invariants that the code enforces
everywhere:

1. **No uncaught promise rejection.** A top-level `unhandledRejection`
   handler prints the stack and continues; `uncaughtException` prints
   and exits (the OS / launch agent decides whether to restart).
2. **No timer leaks.** Every `setTimeout` and `setInterval` is paired
   with a `clearTimeout` / `clearInterval` in the matching `stop()`
   path, and all are `.unref()`'d so they never block process exit.
3. **No duplicate status updates.** The Discord client compares every
   new value to the last value it sent before even queuing.
4. **No duplicate lyric schedulers.** The scheduler is a single class
   with a single timer; there is exactly one instance per runtime.
5. **No duplicated LRCLIB requests.** The provider's L1 + L2 caches
   short-circuit repeat lookups for the same `(track, artist,
   durationBucket)` triple within the TTL window.
6. **No abandoned SMTC reads.** The bridge process is restarted
   automatically if it exits, and the `SmtcService` re-attaches on
   `attached` events.
7. **No token in logs.** The logger redacts any field whose key
   contains `token` / `authorization`, and any string matching a
   Discord-token shape.

---

## Security

* The Discord user token is stored in plain text inside
  `%APPDATA%\DiscordLyricsStatus\config.json`. This is intentional —
  the token is a **user token**, equivalent in privilege to the
  password, and it MUST NOT leave the machine. We do not log it,
  do not send it anywhere except `discord.com/api/v9`, do not
  encrypt it (because Windows DPAPI would couple the install to
  the user profile and break portability). If your machine is
  compromised at the user level the token is already compromised,
  regardless of encryption.
* The setup server binds **only** to `127.0.0.1`. It cannot be
  reached from another machine.
* CSRF token is required on `/submit`.
* Token format is validated server-side before we save it; a
  malformed token never reaches the config file.
* All LRCLIB request parameters are URL-encoded; we never
  interpolate user input into a path.

---

## Windows compatibility

The runtime is tested against:

* Windows 10 + PowerShell 5.1 (the default `powershell.exe`)
* Windows 11 + PowerShell 7 (`pwsh.exe`)
* Both `cmd.exe` and PowerShell shells
* Stripped-down environments where `%PATH%` is missing `cmd.exe`
  or `powershell.exe`

We never call `spawn('cmd', …)` without resolving a concrete path.
We find `cmd.exe` via `ComSpec`, `WINDIR\System32\cmd.exe`, and
`WINDIR\Sysnative\cmd.exe`. We find PowerShell via the explicit
`Program Files\PowerShell \pwsh.exe` paths and
`System32\WindowsPowerShell 1.0\powershell.exe`.

The PowerShell bridge script uses `[Windows.Media.Control.*]` which
is part of the Universal Windows Platform runtime available on every
supported Windows build since 1607. We do not require any third-party
PowerShell modules.

---

## Build pipeline

* `scripts/build.mjs` produces two bundles in `dist/`:
  * `dist/main.mjs` — ESM, used by `node` directly during development.
  * `dist/main.cjs` — CommonJS, used by the SEA packager and by
    `npm start`.
* The CommonJS bundle ships with `dist/package.json` containing
  `"type": "commonjs"` so Node parses it correctly without renaming.
* `scripts/package.mjs` invokes Node's built-in Single Executable
  Application (`--experimental-sea-config`) to fuse the bundle into
  a copy of `node.exe`, with `postject` injecting the SEA blob.
* If SEA is unavailable on the host Node, the packager falls back
  to a portable launcher (`discord-lyrics-status.exe` is `node.exe`
  + `main.cjs` + a `.bat` wrapper). This still works without Node
  installed on the target machine — the `node.exe` is bundled.

Cold-start time is dominated by the OS loading `node.exe`; the bundle
itself is ~42 KiB and parses in tens of milliseconds.

---

## Configuration reference

Stored in `%APPDATA%\DiscordLyricsStatus\config.json`.

```jsonc
{
  "version": 2,
  "discord": {
    "token": "<your discord user token>",
    "userId": null
  },
  "display": {
    "showArtist": true,
    "maxLineLength": 120,
    "separator": " — "
  },
  "lyrics": {
    "provider": "lrclib",
    "timeoutMs": 8000,
    "maxRetries": 4,
    "cacheTtlMs": 86400000
  },
  "scheduler": {
    "tickMs": 100,
    "lookaheadMs": 4000
  },
  "logging": {
    "level": "info",
    "verbose": false
  },
  "setup": { "lastPort": null }
}
```

The config store validates every field on load and on write. Unknown
keys are dropped silently. Corrupt files are moved to
`config.corrupt-<timestamp>.json` and the runtime starts with defaults.

---

## License

MIT — see `LICENSE`.