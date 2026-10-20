# Familyplanner

Weekplanner voor het gezin. De dagen staan als rijen en elk gezinslid heeft een eigen kolom.
De afspraken komen live uit de iCloud-agenda's (CalDAV), en je kan er ook afspraken toevoegen,
aanpassen of verwijderen. Gemaakt voor een wandtablet en voor Home Assistant.

```
iPhone / laptop ── login (Margot/Bart + PIN) ──┐
tablet (Fully Kiosk) / HA ── sleutel (?key=) ─┼──▶ familyplanner ──CalDAV──▶ iCloud (agenda + Reminders)
```

Deployment op het homelab: zie `homelab/services/familyplanner`.

## Hoe afspraken bij de juiste persoon komen

1. **Naam in de titel.** "Janne zwemles" komt bij Janne, waar "zwemles" getoond wordt. Meerdere namen komen in meerdere kolommen.
2. **Agenda van één persoon.** Met `"calendars": ["Winkel"]` bij een persoon komt alles uit die agenda bij die persoon.
3. **Anders** komt de afspraak in de extra kolom (*Samen*).

Een nieuwe afspraak via de planner krijgt de naam vooraan in de titel, zodat ze op de iPhone ook klopt.
Herhalende afspraken worden getoond (↻), maar pas je op de iPhone aan.

## Routines voor de kinderen (`/routine`)

Een speelse pagina waarop Janne (paarden, roos) en Otis (auto's, groen) zelf hun ochtend- en avondroutine afvinken:

- **Ochtend:** omkleden, ontbijten, schoenen. **Avond:** omkleden, avondeten, tanden poetsen. Na `switch_at` (13u) toont de pagina vanzelf de avondroutine.
- Elke taak heeft een groot icoon. Tikken = klaar, met een geluidje en een stempel 🌹 of 🏆. Het paardje of de auto schuift op naar 🥕 of 🏁.
- Is alles klaar, dan volgen confetti, een galopperend paard of een racende auto en een melodietje. Optioneel gaat er een webhook naar Home Assistant.
- **Lang drukken (0,7 s)** op een afgevinkte taak maakt die ongedaan. Dat is bedoeld voor de ouders.
- Onderaan staat de week: een 🌹/🐴 of 🏆/🚗 per voltooide routine.
- Dagelijkse reset, opgeslagen in `DATA_DIR/routines.json`. Stappen, kleuren en emoji pas je aan onder `routines` in `config.json`.

## Inloggen (Margot / Bart)

De huishoud-`AUTH_KEY` blijft werken voor de tablet, Home Assistant en `?key=`.
Daarnaast kun je vanaf iPhone, iPad of laptop inloggen met een gebruiker + PIN (4–8 cijfers).
Zet `USERS` in de omgeving, bijvoorbeeld `[{"name":"Bart","pin":"1111"},{"name":"Margot","pin":"2222"}]`.
Lokaal met `npm run dev` zijn die PIN's `1111` (Bart) en `2222` (Margot).

## Boodschappen en niet-vergeten (`/lists/shopping`, `/lists/todo`)

Gedeelde huishoudlijsten. Als iCloud CalDAV een VTODO-lijst met dezelfde naam toont (Apple Reminders, niet-upgraded), is dat de bron. Anders vallen de lijsten terug op `DATA_DIR/lists.json` — Familyplanner blijft dan zelf de sync tussen apparaten.

De status staat boven de lijst: “Synced met Reminders” of “Alleen Familyplanner”.
Lijstnamen stel je in onder `lists` in `config.json` (`reminder_list` moet exact overeenkomen met de naam in Herinneringen).

Upgraded Apple Reminders (CloudKit, sinds ~iOS 13) zijn vaak niet meer via CalDAV zichtbaar. Maak in dat geval de lijsten in Familyplanner; ze blijven bruikbaar zonder de Herinneringen-app.

## Lokaal draaien

```bash
npm install
npm run dev            # nepdata → http://localhost:3000/login (PIN 1111/2222) of ?key=dev-sleutel-voor-lokaal-testen
npm test               # unit- en API-tests
```

Tegen echte iCloud:

```bash
cp .env.example .env && cp config.example.json config.json   # invullen
podman build -t familyplanner -f Containerfile .
podman run --rm -p 3000:3000 --env-file .env -v ./config.json:/config/config.json:ro,Z familyplanner
```

## Configuratie

| Variabele | Betekenis |
|---|---|
| `ICLOUD_USER` / `ICLOUD_APP_PASSWORD` | Apple ID + app-specifiek wachtwoord |
| `AUTH_KEY` | toegangssleutel (min. 16 tekens) |
| `USERS` | JSON: `[{"name":"Bart","pin":"1111"},{"name":"Margot","pin":"2222"}]` |
| `CONFIG_FILE` | pad naar `config.json` (standaard `/config/config.json`) of `CONFIG` met de JSON zelf |
| `TIMEZONE` | standaard `Europe/Brussels` |
| `FRAME_ANCESTORS` | wie de planner in een iframe mag tonen (Home Assistant) |
| `COOKIE_SECURE` | `auto` (enkel via https), `true` of `false` |
| `TRUST_PROXY` | `1` achter een reverse proxy die `X-Forwarded-Proto` zet |
| `MOCK` | `1` = nepdata, geen iCloud nodig |
| `DATA_DIR` | map voor `routines.json` en `lists.json` (standaard `/data` in de container) |
| `HA_WEBHOOK_URL` | optioneel: Home Assistant-webhook bij een voltooide routine |

`config.json`: zie `config.example.json`.

## API

Authenticatie via `Authorization: Bearer <AUTH_KEY>` of een ingelogde sessie.

| Methode | Pad | Wat |
|---|---|---|
| GET | `/api/week?start=YYYY-MM-DD` | week (maandag–zondag) met afspraken per kolom |
| GET | `/api/ha/summary` | vandaag + morgen, compact voor Home Assistant |
| POST | `/api/events` | `{ person, title, date, start, end }` of `{ person, title, date, allDay: true }` (`calendar` optioneel) |
| PATCH | `/api/events` | `{ href, etag, person, title, date, … }` (niet voor herhalende afspraken) |
| DELETE | `/api/events` | `{ href, etag }` |
| GET | `/api/me` | wie er is ingelogd (`type`: `key` of `user`) |
| GET | `/api/routines?date=` | routines, stand van vandaag en weekoverzicht |
| POST | `/api/routines/toggle` | `{ child, routine: morning\|evening, step, done }` |
| GET | `/api/ha/routines` | compact per kind: `done/total/complete/todo` |
| GET | `/api/lists` | boodschappen + niet-vergeten |
| GET | `/api/lists/:id` | één lijst (`shopping` of `todo`) |
| POST | `/api/lists/:id/items` | `{ title }` |
| PATCH | `/api/lists/:id/items` | `{ id, href?, etag?, completed?, title? }` |
| DELETE | `/api/lists/:id/items` | `{ id, href?, etag? }` |
| POST | `/api/refresh` | lijst van agenda's opnieuw ophalen |
| GET | `/healthz` | gezondheidscheck (zonder login) |

## Image bouwen

Bij elke push naar `main` bouwt GitHub Actions `ghcr.io/bartjoris/familyplanner:latest` (zie `.github/workflows/build.yml`).
