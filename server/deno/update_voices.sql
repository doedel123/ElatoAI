-- Provider -> gemini + passende Gemini-Live-Stimme je Personality.
-- Im Supabase Dashboard: SQL Editor -> Paste -> Run.
UPDATE personalities SET provider = 'gemini', oai_voice = v.voice
FROM (VALUES
    ('art_guru', 'Aoede'),
    ('batman', 'Algenib'),
    ('aggie_blood_test_pal', 'Achernar'),
    ('surfer_bro_chill_vibe', 'Zubenelgenubi'),
    ('captain_coral_reef', 'Laomedeia'),
    ('toad', 'Fenrir'),
    ('standup_comedian_funny_friend', 'Puck'),
    ('eco_champ', 'Autonoe'),
    ('elato_default', 'Zephyr'),
    ('elsa', 'Kore'),
    ('fitness_coach', 'Alnilam'),
    ('kids_football_teacher', 'Sadachbia'),
    ('gandalf', 'Charon'),
    ('geo_guide', 'Rasalgethi'),
    ('ironman', 'Algieba'),
    ('dramatic_theater_actor', 'Enceladus'),
    ('hipster_barista_sarcastic', 'Umbriel'),
    ('kids_books', 'Sulafat'),
    ('luna_epilepsy_pal', 'Vindemiatrix'),
    ('luna_stargazer', 'Leda'),
    ('marco_time_machine', 'Puck'),
    ('master_chef', 'Gacrux'),
    ('math_wiz', 'Erinome'),
    ('bear_maximillian', 'Achird'),
    ('miles_multiverse_mission', 'Iapetus'),
    ('kids_english_teacher', 'Callirrhoe'),
    ('pip_pixie_garden', 'Despina'),
    ('porous_pete', 'Fenrir'),
    ('professor_particle_lab', 'Sadaltager'),
    ('qura', 'Aoede'),
    ('rex_lost_world', 'Leda'),
    ('bear_sam', 'Schedar'),
    ('santa_claus', 'Orus'),
    ('sherlock', 'Charon'),
    ('bear_oliver', 'Algieba'),
    ('kids_astronomy', 'Zephyr'),
    ('surfer_gal_beach_vibes', 'Laomedeia'),
    ('kids_math_teacher', 'Zubenelgenubi'),
    ('trixie_time_safari', 'Autonoe'),
    ('vax_buddy', 'Achird'),
    ('zara_zoo_detective', 'Pulcherrima')
) AS v(key, voice)
WHERE personalities.key = v.key;

-- Kontrolle: sollte 41 Zeilen mit provider='gemini' zeigen.
SELECT provider, count(*) FROM personalities GROUP BY provider;
