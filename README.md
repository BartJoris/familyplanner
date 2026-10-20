# Familyplanner

Weekplanner voor het gezin. De dagen staan als rijen en elk gezinslid heeft een eigen kolom.
De afspraken komen live uit de iCloud-agenda's (CalDAV), en je kan er ook afspraken toevoegen,
aanpassen of verwijderen. Gemaakt voor een wandtablet en voor Home Assistant.

```
tablet (Fully Kiosk) ──┐
Home Assistant ────────┼──▶ familyplanner (container, poort 3000) ──CalDAV──▶ iCloud
                       │      sleutel (cookie, Bearer of ?key=)
```

Deployment op het homelab: zie `homelab/services/familyplanner`.

## Hoe afspraken bij de juiste persoon komen

1. **Naam in de titel.** "Janne zwemles" komt bij Janne, waar "zwemles" getoond wordt. Meerdere namen komen in meerdere kolommen.
2. **Agenda van één persoon.** Met `"calendars": ["Winkel"]` bij een persoon komt alles uit die agenda bij die persoon.
3. **Anders** komt de afspraak in de extra kolom (*Samen*).

Een nieuwe afspraak via de planner krijgt de naam vooraan in de titel, zodat ze op de iPhone ook klopt.
Herhalende afspraken worden getoond (↻), maar pas je op de iPhone aan.

## Lokaal draaien

```bash
npm install
npm run dev            # nepdata → http://localhost:3000/?key=dev-sleutel-voor-lokaal-testen
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
| `CONFIG_FILE` | pad naar `config.json` (standaard `/config/config.json`) of `CONFIG` met de JSON zelf |
| `TIMEZONE` | standaard `Europe/Brussels` |
| `FRAME_ANCESTORS` | wie de planner in een iframe mag tonen (Home Assistant) |
| `COOKIE_SECURE` | `auto` (enkel via https), `true` of `false` |
| `TRUST_PROXY` | `1` achter een reverse proxy die `X-Forwarded-Proto` zet |
| `MOCK` | `1` = nepdata, geen iCloud nodig |

`config.json`: zie `config.example.json`.

## API

Authenticatie via `Authorization: Bearer <AUTH_KEY>`.

| Methode | Pad | Wat |
|---|---|---|
| GET | `/api/week?start=YYYY-MM-DD` | week (maandag–zondag) met afspraken per kolom |
| GET | `/api/ha/summary` | vandaag + morgen, compact voor Home Assistant |
| POST | `/api/events` | `{ person, title, date, start, end }` of `{ person, title, date, allDay: true }` (`calendar` optioneel) |
| PATCH | `/api/events` | `{ href, etag, person, title, date, … }` (niet voor herhalende afspraken) |
| DELETE | `/api/events` | `{ href, etag }` |
| POST | `/api/refresh` | lijst van agenda's opnieuw ophalen |
| GET | `/healthz` | gezondheidscheck (zonder login) |

## Image bouwen

Bij elke push naar `main` bouwt GitHub Actions `ghcr.io/bartjoris/familyplanner:latest` (zie `.github/workflows/build.yml`).
