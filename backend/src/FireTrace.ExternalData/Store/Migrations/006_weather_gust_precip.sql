-- Gusts and rain are inputs of the fire model (the midflame gust blend, rain wetting and rain extinction), so they are stored with the
-- provider hour instead of being thrown away.
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS gust_kmh real NOT NULL DEFAULT 0;
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS precip_mm_h real NOT NULL DEFAULT 0;

-- Older rows were fetched without these fields and their defaults would read as "no gust, no rain". Weather is only a cache, so drop
-- them once; the next request refetches the same hours with the full payload.
DELETE FROM weather_obs;
