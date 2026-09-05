-- NFC tags map a physical NFC tag (Toniebox-style figure) to a personality.
-- The ESP32 reads the tag's UID and queries the backend to get the matching
-- personality (image + data), analogous to identifying a device by MAC address.

CREATE TABLE IF NOT EXISTS "public"."nfc_tags" (
    "nfc_tag_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    -- Normalized tag UID: uppercase hex, no separators (e.g. "044EE57A601B90").
    -- The API normalizes incoming UIDs the same way so the firmware can send
    -- any format (colons/dashes/lowercase).
    "nfc_id" "text" NOT NULL,
    "personality_id" "uuid" NOT NULL,
    -- Human-readable label, e.g. "Käptn Toad figure".
    "label" "text" DEFAULT ''::"text" NOT NULL
);

ALTER TABLE "public"."nfc_tags" OWNER TO "postgres";

COMMENT ON TABLE "public"."nfc_tags" IS 'maps physical NFC tags to personalities (Toniebox-style)';
COMMENT ON COLUMN "public"."nfc_tags"."nfc_id" IS 'normalized tag UID: uppercase hex, no separators';

ALTER TABLE ONLY "public"."nfc_tags"
    ADD CONSTRAINT "nfc_tags_pkey" PRIMARY KEY ("nfc_tag_id");

ALTER TABLE ONLY "public"."nfc_tags"
    ADD CONSTRAINT "nfc_tags_nfc_id_key" UNIQUE ("nfc_id");

ALTER TABLE ONLY "public"."nfc_tags"
    ADD CONSTRAINT "nfc_tags_personality_id_fkey" FOREIGN KEY ("personality_id")
    REFERENCES "public"."personalities"("personality_id") ON DELETE CASCADE;

-- RLS: same pattern as devices/personalities (public read access).
ALTER TABLE "public"."nfc_tags" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for all users" ON "public"."nfc_tags"
    FOR SELECT USING (true);

GRANT ALL ON TABLE "public"."nfc_tags" TO "anon";
GRANT ALL ON TABLE "public"."nfc_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."nfc_tags" TO "service_role";

-- Seed the two physical tags.
-- Käptn Toad: 04:4E:E5:7A:60:1B:90
-- Elsa:       04:BC:53:94:DD:2A:81
INSERT INTO "public"."nfc_tags" ("nfc_id", "personality_id", "label") VALUES
    ('044EE57A601B90', '923fd6a2-d3e0-4bb7-82d6-1e4238e7b7ef', 'Käptn Toad'),
    ('04BC5394DD2A81', 'c004c692-da13-4bce-b3e2-f2a5f510d64e', 'Elsa')
ON CONFLICT ("nfc_id") DO UPDATE
    SET "personality_id" = EXCLUDED."personality_id",
        "label" = EXCLUDED."label";
