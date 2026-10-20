-- Rajadas, precipitação e nebulosidade de cada hora meteorológica. `detail_version` 0 = hora guardada antes destes campos: é obtida outra vez ao pedir esse período.
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS gust_kmh real;
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS precip_mmh real;
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS cloud_pct real;
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS detail_version smallint NOT NULL DEFAULT 0;
