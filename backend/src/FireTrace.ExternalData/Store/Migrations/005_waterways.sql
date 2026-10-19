-- Cursos de água (rios, canais, ribeiras): travam a propagação do fogo no ajuste da paisagem.
CREATE TABLE IF NOT EXISTS waterways (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('river','canal','stream','drain')),
  name text,
  width_m double precision,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS waterways_geom ON waterways USING gist (geom);
CREATE INDEX IF NOT EXISTS waterways_loc ON waterways (location_id, kind);
