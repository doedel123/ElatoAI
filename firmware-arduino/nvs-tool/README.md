# XIAOZHI NVS Backend-Switcher

Pointet ein bereits geflashtes XIAOZHI-ESP32-Gerät auf einen **eigenen Server**
— **ohne Neukompilieren/Neuflashen der Firmware**. Es schreibt nur den Schlüssel
`wifi:ota_url` direkt in die NVS-Partition des Geräts.

Die Firmware liest beim Start `settings.GetString("ota_url")` und nutzt diesen
Wert mit Vorrang vor dem einkompilierten `CONFIG_OTA_URL`. Der OTA-Endpunkt
liefert dann unsere WebSocket-URL zurück (`/xiaozhi/v1/`).

## Herkunft

Übernommen aus **[rebelthor/warble](https://github.com/rebelthor/warble/tree/main/nvs-tool)**
(MIT License, © 2026 rebelthor). Unverändert kopiert.

## Voraussetzungen (bereits eingerichtet)

- `python3` (getestet mit 3.14)
- `esptool` v5 — installiert via `pipx install esptool` (liegt in `~/.local/bin`)
- ESP32 per USB verbunden

## Was es macht

1. Liest NVS-Partition (`0x9000`, Größe `0x4000`) per `esptool read-flash`
2. Legt ein Backup an (`~/stackchan-nvs-backup-<ts>.bin` — enthält **WLAN-Klartext-Creds**)
3. Fügt `wifi:ota_url=<URL>` **chirurgisch** ein (alle anderen Keys inkl. WLAN + PHY-Cal bleiben erhalten)
4. Flasht zurück und liest zur Verifikation erneut aus

> Achtung: Der Vorgang **resettet den Chip**. Laufende Serial-Sessions
> (idf-monitor, screen, cat) vorher beenden, sonst ist der Port belegt.

## Nutzung

```bash
# Seriellen Port finden (macOS):
ls /dev/cu.usbmodem*

# Auf DEINEN Server umschalten:
./switch_backend.sh https://elatoai.aionetwo.deno.net/xiaozhi/ota/ /dev/cu.usbmodemXXXX

# Zurück auf die offizielle Cloud:
./switch_backend.sh https://api.tenclass.net/xiaozhi/ota/ /dev/cu.usbmodemXXXX
```

Ohne zweiten Parameter ist der Default-Port `/dev/cu.usbmodem1101`.

Danach auf dem Gerät die „AI Agent"-App öffnen → es macht OTA-Check gegen
deinen Endpunkt und verbindet den WebSocket.

## Einzelschritte (falls nötig)

```bash
# Nur auslesen:
esptool --port /dev/cu.usbmodemXXXX read-flash 0x9000 0x4000 nvs.bin

# Inhalt anzeigen (ota_url, ssid, CRC):
python3 nvs_partition_tool.py nvs.bin -d minimal -i | grep -E "ota_url|ssid|CRC32"

# ota_url einfügen:
python3 nvs_insert.py nvs.bin nvs_new.bin wifi ota_url https://elatoai.aionetwo.deno.net/xiaozhi/ota/
```

## Wichtig zur MAC / Geräte-Zuordnung

Unser Server authentifiziert XIAOZHI-Geräte über die **MAC** (`Device-Id`). Die
MAC des Geräts muss in der Supabase-`devices`-Tabelle einem User mit Personality
(Provider `openai` oder `gemini`) zugeordnet sein — sonst lehnt der WebSocket ab.
