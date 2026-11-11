BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE relief.disasters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL
);
INSERT INTO relief.disasters (slug, name) VALUES
  ('valencia-dana', 'Valencia DANA floods'),
  ('hurricane-melissa', 'Hurricane Melissa');

CREATE TABLE relief.sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id text NOT NULL UNIQUE,
  canonical_url text CHECK (canonical_url ~ '^https?://[^[:space:]]+$'),
  method text NOT NULL CHECK (method IN ('web', 'file')),
  CHECK (method <> 'web' OR canonical_url IS NOT NULL)
);

CREATE TABLE relief.source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES relief.sources,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  extraction_version text NOT NULL,
  cleaned_text text NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
  publisher text,
  language text,
  publication_date date,
  retrieved_at timestamptz NOT NULL,
  review_state text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES relief.staff_roles(user_id),
  reviewed_at timestamptz,
  CHECK ((review_state = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (review_state <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  UNIQUE (source_id, content_hash, extraction_version)
);

CREATE TABLE relief.source_disasters (
  source_version_id uuid NOT NULL REFERENCES relief.source_versions,
  disaster_id uuid NOT NULL REFERENCES relief.disasters,
  PRIMARY KEY (source_version_id, disaster_id)
);

CREATE TABLE relief.embedding_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'gemini'),
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 768),
  input_format_version text NOT NULL,
  UNIQUE (provider, model, dimensions, input_format_version)
);

CREATE TABLE relief.releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_release_id uuid REFERENCES relief.releases,
  status text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'published', 'retired', 'failed')),
  embedding_profile_id uuid NOT NULL REFERENCES relief.embedding_profiles,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES relief.staff_roles(user_id)
);
CREATE UNIQUE INDEX one_published_release ON relief.releases ((status)) WHERE status = 'published';

CREATE TABLE relief.release_sources (
  release_id uuid NOT NULL REFERENCES relief.releases,
  source_version_id uuid NOT NULL REFERENCES relief.source_versions,
  PRIMARY KEY (release_id, source_version_id)
);

CREATE TABLE relief.chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_version_id uuid NOT NULL REFERENCES relief.source_versions,
  chunker_version text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 2400),
  text_hash text NOT NULL CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  locator text NOT NULL CHECK (char_length(btrim(locator)) BETWEEN 1 AND 500),
  embedding_input_hash text NOT NULL CHECK (embedding_input_hash ~ '^[0-9a-f]{64}$'),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('pg_catalog.simple'::regconfig, text)) STORED,
  UNIQUE (source_version_id, chunker_version, ordinal),
  UNIQUE (id, source_version_id)
);
CREATE INDEX chunks_search_vector_idx ON relief.chunks USING gin (search_vector);

CREATE TABLE relief.release_chunks (
  release_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  disaster_id uuid NOT NULL,
  PRIMARY KEY (release_id, disaster_id, chunk_id),
  FOREIGN KEY (release_id, source_version_id) REFERENCES relief.release_sources,
  FOREIGN KEY (chunk_id, source_version_id) REFERENCES relief.chunks (id, source_version_id),
  FOREIGN KEY (source_version_id, disaster_id) REFERENCES relief.source_disasters
);

CREATE TABLE relief.chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES relief.chunks,
  profile_id uuid NOT NULL REFERENCES relief.embedding_profiles,
  embedding extensions.vector(768) NOT NULL CHECK (abs(extensions.vector_norm(embedding) - 1) < 0.001),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, profile_id)
);

CREATE TABLE relief.kb_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_release_id uuid REFERENCES relief.releases,
  epoch integer NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES relief.staff_roles(user_id)
);
INSERT INTO relief.kb_state DEFAULT VALUES;

CREATE VIEW relief.active_corpus AS
SELECT r.id AS release_id, k.epoch, p.id AS profile_id, p.model, p.dimensions
FROM relief.kb_state k
JOIN relief.releases r ON r.id = k.active_release_id AND r.status = 'published'
JOIN relief.embedding_profiles p ON p.id = r.embedding_profile_id;

CREATE VIEW relief.published_chunks AS
SELECT rc.release_id, rc.disaster_id, c.id AS chunk_id, v.id AS source_version_id,
       c.text, c.locator, c.ordinal, c.search_vector, v.title, s.canonical_url AS source_url,
       to_char(v.publication_date, 'YYYY-MM-DD') AS publication_date, v.reviewed_at,
       v.review_state, a.profile_id, e.embedding
FROM relief.active_corpus a
JOIN relief.release_chunks rc ON rc.release_id = a.release_id
JOIN relief.chunks c ON c.id = rc.chunk_id
JOIN relief.source_versions v ON v.id = rc.source_version_id AND v.review_state = 'approved'
JOIN relief.sources s ON s.id = v.source_id
LEFT JOIN relief.chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = a.profile_id;

CREATE TABLE relief.corpus_publications (
  epoch integer PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES relief.releases,
  actor_id uuid NOT NULL REFERENCES relief.staff_roles(user_id),
  published_at timestamptz NOT NULL DEFAULT now()
);

-- Invoke as the migration/operator role after staging a reviewed, fully embedded release.
CREATE FUNCTION relief.publish_corpus(target uuid, expected_epoch integer, actor uuid)
RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, relief AS $$
DECLARE
  previous uuid;
  current_epoch integer;
  profile uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM relief.staff_roles WHERE user_id = actor AND enabled AND role = 'admin') THEN
    RAISE EXCEPTION 'An enabled admin is required';
  END IF;
  SELECT active_release_id, epoch INTO STRICT previous, current_epoch
  FROM relief.kb_state WHERE singleton FOR UPDATE;
  IF current_epoch IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'The corpus epoch changed';
  END IF;
  SELECT embedding_profile_id INTO profile FROM relief.releases
  WHERE id = target AND status = 'ready' AND parent_release_id IS NOT DISTINCT FROM previous FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Release must be ready and built from the current active release';
  END IF;
  IF EXISTS (
    SELECT 1 FROM relief.release_sources rs JOIN relief.source_versions v ON v.id = rs.source_version_id
    WHERE rs.release_id = target AND (v.review_state <> 'approved' OR NOT EXISTS (
      SELECT 1 FROM relief.release_chunks c WHERE c.release_id = target AND c.source_version_id = v.id
    ))
  ) OR EXISTS (
    SELECT 1 FROM relief.disasters d WHERE NOT EXISTS (
      SELECT 1 FROM relief.release_chunks c WHERE c.release_id = target AND c.disaster_id = d.id
    )
  ) OR EXISTS (
    SELECT 1 FROM relief.release_chunks c WHERE c.release_id = target AND NOT EXISTS (
      SELECT 1 FROM relief.chunk_embeddings e WHERE e.chunk_id = c.chunk_id AND e.profile_id = profile
    )
  ) THEN
    RAISE EXCEPTION 'Release requires approved sources, chunks for both disasters and matching embeddings';
  END IF;
  UPDATE relief.releases SET status = 'retired' WHERE id = previous;
  UPDATE relief.releases SET status = 'published' WHERE id = target;
  UPDATE relief.kb_state SET active_release_id = target, epoch = current_epoch + 1,
    updated_at = now(), updated_by = actor WHERE singleton;
  INSERT INTO relief.corpus_publications (epoch, release_id, actor_id) VALUES (current_epoch + 1, target, actor);
  RETURN current_epoch + 1;
END
$$;

REVOKE ALL ON FUNCTION relief.publish_corpus(uuid, integer, uuid) FROM PUBLIC;
COMMIT;
