-- Personality visibility and generated portraits (concierge "create_personality").
--
-- status:    'private'  only the creator sees it (default for user-created rows)
--            'tocheck'  creator asked to publish; hidden until reviewed
--            'public'   visible to everyone (all built-in personalities)
-- image_url: reserved for an externally hosted portrait; generated portraits are
--            stored in the private storage bucket below and served by the Deno
--            server under /personality/<key>.jpeg, so this stays NULL for them.

ALTER TABLE personalities
    ADD COLUMN IF NOT EXISTS status TEXT CHECK (status IN ('private', 'tocheck', 'public'));

ALTER TABLE personalities
    ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Backfill before setting the default: built-in rows (no creator) become
-- public, everything a user created stays private to that user.
UPDATE personalities
SET status = CASE WHEN creator_id IS NULL THEN 'public' ELSE 'private' END
WHERE status IS NULL;

ALTER TABLE personalities
    ALTER COLUMN status SET DEFAULT 'private';

-- Private bucket for generated portraits. Only the server's service-role
-- client reads and writes it; no storage policies are needed.
INSERT INTO storage.buckets (id, name, public)
VALUES ('personality-images', 'personality-images', false)
ON CONFLICT (id) DO NOTHING;
