
# Elato AI WebSocket Server (Deno)

For more details, visit the [Elato Deno Server Docs](https://www.elatoai.com/docs/blog/edge-server).

## Gemini Live

Concierge und direkte Gemini-Personalities verwenden standardmäßig `gemini-3.8-live`.
`GEMINI_LIVE_MODEL` kann das Modell serverseitig überschreiben; beim Deployment einen
bereits gesetzten alten Wert ebenfalls auf `gemini-3.8-live` ändern oder entfernen.
Beim Personality-Wechsel bleibt das ausgewählte Modell erhalten.

Die Tool-Deklarationen setzen ausdrücklich `behavior: BLOCKING`, damit Gesichtserkennung,
Memories und Personality-Wechsel abgeschlossen sind, bevor das Modell weiterantwortet.
Sprachausgabe und beide Transkriptionen bleiben aktiviert. Die bevorzugte Sprache steht
im Systemprompt; `speechConfig.languageCode` wird nicht gesendet, da native Audiomodelle
diesen Parameter nicht unterstützen. Es werden auch keine Thinking-, Affective-Dialog-
oder Proactivity-Einstellungen gesendet. Die Variante `gemini-3.8-live-extended-thinking`
benötigt eine andere Tool- und Turn-Verarbeitung und wird hier nicht unterstützt.

Referenzen: [Gemini 3.8 Live und Migration](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live),
[Live-Audio und Sprache](https://ai.google.dev/gemini-api/docs/live-api/capabilities#change-voice-and-language).

Die Integrationstests prüfen die tatsächlich vom Google-SDK serialisierten Setup- und
Begrüßungsnachrichten mit einem simulierten Transport. Nur ImageScripts WASM-Dateien
werden beim Modulimport von `deno.land` geladen; Gemini wird nicht aufgerufen:

```sh
cd server/deno
deno test --allow-env --allow-read=node_modules --allow-net=deno.land models/gemini_live_test.ts
deno check main.ts
```

## Gesichtserkennung im xiaozhi-Pfad

Optional erkennt der Server einzelne Personen über Amazon Rekognition. Unterstützt sind
der Gemini-Concierge, alle darüber gestarteten Personalities sowie direkte Gemini- und
OpenAI-Sessions. Der Account bleibt unverändert; die sprechende Person erhält ein eigenes
Profil in `known_people` unter dessen `account_id`.

Beispiel: James fragt ein unbekanntes Gesicht nach dem Namen. „Leo, Amelies Bruder“
wird nach einer ausdrücklichen Zustimmung zum Merken des Gesichts gespeichert. Beim
nächsten Erkennen erhalten James und die Personalities Leos Namen, die Beziehung und
seine eigenen Erinnerungen. Die angegebenen Beziehungen der bekannten Personen sind
innerhalb des Accounts verfügbar, persönliche Erinnerungen bleiben personenbezogen.
Auch Amelie muss einmal registriert werden; der DB-Name allein identifiziert kein Gesicht.

Der Web-Simulator zeigt unter der Kamera die aktuell erkannte Person mit Namen und Beziehung.
Die Anzeige folgt den Serverereignissen auch beim Einlernen, bei unsicheren Treffern und bei
Fehlern. Beim erneuten Erkennen oder Trennen der Verbindung wird die vorherige Person ausgeblendet.
Ist die Funktion ausgeschaltet, erscheint „Deaktiviert“. Dazu sendet der xiaozhi-Adapter eine
`custom`-Nachricht mit `action: "face_status"`; sie enthält keine Gesichtsvorlagen oder Memories.

### Aktivierung

1. Migration `supabase/migrations/20260920120000_add_known_people.sql` anwenden.
2. Serverseitig `SUPABASE_SERVICE_ROLE_KEY`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` und
   `AWS_SECRET_ACCESS_KEY` setzen; bei temporären AWS-Zugangsdaten auch `AWS_SESSION_TOKEN`.
3. `FACE_RECOGNITION_ENABLED=true` setzen und den Deno-Server neu deployen/starten.
   Standard ist `false`; ohne Aktivierung läuft der bisherige Gesprächsablauf weiter.
4. Für persönliche Langzeiterinnerungen muss die vorhandene Vertex Memory Bank mit
   `VERTEX_MEMORY_ENGINE` und `GCP_SA_KEY_JSON` oder `GCP_SA_KEY_FILE` konfiguriert sein.
   Namen und Beziehungen werden unabhängig davon in Supabase gespeichert. Bei fehlender
   Memory-Konfiguration meldet `remember` keinen erfolgreichen Save.

Die Kamera muss das MCP-Tool `self.camera.take_photo` unterstützen. Die vorhandene Firmware
sendet die übergebene `question` im Upload zurück; darin steht nun die eindeutige Fotoauftrags-ID.
Es ist keine Firmwareänderung erforderlich.

Benötigte AWS-IAM-Rechte (AWS-Account-ID und Region ersetzen):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["rekognition:DetectFaces", "rekognition:CreateCollection"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["rekognition:SearchFacesByImage", "rekognition:IndexFaces", "rekognition:DeleteFaces"],
      "Resource": "arn:aws:rekognition:eu-central-1:AWS_ACCOUNT_ID:collection/elato_*"
    }
  ]
}
```

### Verhalten und Daten

- Die Begrüßungsanweisung fordert `recognize_person` vor einer persönlichen Ansprache an.
  Bei angekündigtem Sprecherwechsel oder korrigierter Identifikation kann das Modell erneut
  erkennen. Es gibt keine laufende Videoüberwachung oder automatische Sprecherverfolgung.
- Pro Aufnahme ist genau ein ausreichend helles, scharfes Gesicht erlaubt. Treffer brauchen
  mindestens 99 % Ähnlichkeit und drei Prozentpunkte Abstand zum zweitbesten Treffer.
  Diese Schwelle ist ein Startwert, keine garantierte Erkennungsgenauigkeit; auf dem echten
  Gerät insbesondere mit Geschwistern prüfen. Mehrdeutige Treffer und Fehler führen zu
  neutraler Ansprache, nicht zu einer neuen Registrierung.
- Die AWS-Collection heißt `elato_<account_uuid>`. Rekognition speichert Gesichtsvorlagen;
  Namen und Beziehungen stehen nur in Supabase. Es wird kein S3-Bucket benötigt.
- Unbekannte Aufnahmen bleiben höchstens zwei Minuten als Registrierungskandidat im
  Sitzungsspeicher. Die Registrierung verwendet genau dieses Foto und benötigt dessen
  `observation_id` sowie `consent=true`. Gesichtsfotos landen nicht im wiederverwendbaren
  Kamera-Cache und werden nicht an das Gesprächsmodell geschickt.
- Persönliche Memory-Bank-Einträge verwenden den Scope
  `<account_uuid>:person:<person_uuid>`. Alte Account-Erinnerungen und gemischte Chatverläufe
  werden bei aktiver Gesichtserkennung nicht geladen oder automatisch einer Person zugeordnet.
  Gemini speichert zuordenbare Transkripte in diesem Scope; OpenAI nutzt explizite
  `remember`-/`recall`-Aufrufe. Gesprächszeilen behalten `user_id` und erhalten zusätzlich
  `person_id`; unklare Übergangsturns bleiben ohne Personenzuordnung. OpenAI-Protokolle bleiben
  wegen überlappender Transkriptions-/Tool-Ereignisse generell ohne `person_id`; dessen explizite
  Erinnerungen sind trotzdem personenbezogen.
- `forget_person` entfernt nach Bestätigung die erkannte Gesichtsvorlage und das Profil.
  Gesprächsprotokolle und Vertex-Erinnerungen werden dadurch nicht gelöscht. Vor dem
  administrativen Löschen eines Accounts dessen AWS-Collection separat entfernen; ein
  Supabase-Cascade löscht keine externen AWS-Daten. Bei einem protokollierten fehlgeschlagenen
  Enrollment-Rollback verwaiste Templates in der betroffenen Collection bereinigen.
- Gesichtserkennung ist Gesprächspersonalisierung, keine Anmeldung oder Zugriffskontrolle.
  Der bestehende xiaozhi-Gerätezugang über Device-ID und der Kamera-Upload bleiben bestehen;
  nur für vertrauenswürdig angebundene Geräte einsetzen und den Vision-Token konfigurieren.
  Ein Foto kann eine Person imitieren; eine Lebenderkennung ist nicht enthalten.

AWS-Referenzen: [IndexFaces](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_IndexFaces.html),
[SearchFacesByImage](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_SearchFacesByImage.html),
[IAM-Aktionen](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonrekognition.html).

### Lokale Prüfung

```sh
cd server/deno
deno test --allow-env --allow-read=node_modules faces_test.ts face_backend_test.ts speaker_prompts_test.ts
deno check main.ts
```

Die Tests verwenden simulierte AWS-, Kamera- und Datenbankantworten, keine echten Gesichter
oder kostenpflichtigen API-Aufrufe. Für den Gerätetest nacheinander Amelie und ihren Bruder
registrieren, neu verbinden und jeweils in eine Personality wechseln; außerdem eine Aufnahme
mit beiden Personen und einen AWS-Ausfall prüfen. Deployment und Cloud-Migration sind von
der lokalen Implementierung getrennte Schritte.
