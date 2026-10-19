CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE locations (
  id text PRIMARY KEY,
  name text NOT NULL,
  definition jsonb NOT NULL,
  updated timestamptz NOT NULL DEFAULT now()
);

-- Grelhas raster (relevo, combustível, uso do solo): arrays compactos carregados em memória por local.
CREATE TABLE grids (
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  layer text NOT NULL,
  width int NOT NULL,
  height int NOT NULL,
  cell_m double precision NOT NULL,
  dtype text NOT NULL,
  data bytea NOT NULL,
  updated timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, layer)
);

CREATE TABLE road_nodes (
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  id text NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  PRIMARY KEY (location_id, id)
);

CREATE TABLE road_edges (
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  id int NOT NULL,
  name text NOT NULL,
  ref text NOT NULL DEFAULT '',
  highway text NOT NULL DEFAULT '',
  a text NOT NULL,
  b text NOT NULL,
  length_m double precision NOT NULL,
  geom geometry(LineString, 4326) NOT NULL,
  PRIMARY KEY (location_id, id)
);
CREATE INDEX road_edges_geom ON road_edges USING gist (geom);

CREATE TABLE facilities (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('fire_station','gnr','civil_protection','inem','hospital','town_hall')),
  name text NOT NULL,
  operator text,
  source text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1,
  geom geometry(Point, 4326) NOT NULL
);
CREATE INDEX facilities_geom ON facilities USING gist (geom);
CREATE INDEX facilities_loc ON facilities (location_id, type);

CREATE TABLE places (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  population int NOT NULL,
  population_estimated boolean NOT NULL,
  geom geometry(Point, 4326) NOT NULL
);
CREATE INDEX places_geom ON places USING gist (geom);

CREATE TABLE imagery_assets (
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source text NOT NULL,
  zoom int NOT NULL,
  path text NOT NULL,
  west double precision NOT NULL, south double precision NOT NULL, east double precision NOT NULL, north double precision NOT NULL,
  attribution text NOT NULL,
  PRIMARY KEY (location_id, kind)
);

CREATE TABLE weather_obs (
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  provider text NOT NULL,
  wind_kmh real NOT NULL,
  wind_from real NOT NULL,
  rh real NOT NULL,
  temp_c real NOT NULL,
  PRIMARY KEY (location_id, ts)
);

CREATE TABLE sim_runs (
  id uuid PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created timestamptz NOT NULL DEFAULT now(),
  start_ts timestamptz NOT NULL,
  duration_min int NOT NULL,
  ign_lat double precision NOT NULL,
  ign_lon double precision NOT NULL,
  params jsonb NOT NULL,
  weather jsonb NOT NULL,
  ign_grid bytea NOT NULL,
  members bytea NOT NULL,
  member_count int NOT NULL
);
