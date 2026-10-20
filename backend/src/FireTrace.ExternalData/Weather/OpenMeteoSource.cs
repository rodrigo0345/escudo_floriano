using System.Globalization;
using System.Text.Json;
using Dapper;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using Npgsql;

namespace FireTrace.ExternalData.Weather;

/// <summary>
/// Real hourly weather by date: Open-Meteo archive (ERA5) for the past, forecast for the recent days and the future.
/// Every hour fetched is stored in PostgreSQL (`weather_obs`), so replaying a past fire is instant the second time.
/// </summary>
public sealed class OpenMeteoSource(HttpClient http, NpgsqlDataSource db, OpenMeteoOptions options, TimeProvider time) : IWeatherSource
{
    const string ArchiveProvider = "open-meteo-archive";
    const string ForecastProvider = "open-meteo-forecast";

    public async Task<IReadOnlyList<HourlyWeather>> GetHourlyAsync(string locationId, LatLon point, DateTimeOffset from, DateTimeOffset to, CancellationToken ct = default)
    {
        from = Hour(from);
        to = Hour(to).AddHours(1);
        var cached = await LoadAsync(locationId, from, to, ct);
        if (cached.Count >= (int)(to - from).TotalHours + 1) return cached;

        // ERA5 lags a few days behind: the recent past comes from the forecast/analysis endpoint
        var cutoff = time.GetUtcNow().UtcDateTime.Date.AddDays(-options.Era5ArchiveLagDays);
        if (from.UtcDateTime.Date < cutoff)
        {
            var end = to.UtcDateTime.Date < cutoff ? to : new DateTimeOffset(cutoff.AddDays(-1), TimeSpan.Zero);
            await StoreAsync(locationId, await FetchAsync(options.ArchiveBaseUrl, ArchiveProvider, point, from, end, ct), ct);
        }
        if (to.UtcDateTime.Date >= cutoff)
        {
            var start = from.UtcDateTime.Date < cutoff ? new DateTimeOffset(cutoff, TimeSpan.Zero) : from;
            await StoreAsync(locationId, await FetchAsync(options.ForecastBaseUrl, ForecastProvider, point, start, to, ct), ct);
        }
        return await LoadAsync(locationId, from, to, ct);
    }

    static DateTimeOffset Hour(DateTimeOffset t) => new(t.UtcDateTime.Date.AddHours(t.UtcDateTime.Hour), TimeSpan.Zero);

    async Task<List<HourlyWeather>> FetchAsync(string baseUrl, string provider, LatLon p, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        var inv = CultureInfo.InvariantCulture;
        var url = $"{baseUrl}?latitude={p.Lat.ToString(inv)}&longitude={p.Lon.ToString(inv)}&start_date={from.UtcDateTime:yyyy-MM-dd}&end_date={to.UtcDateTime:yyyy-MM-dd}" +
                  "&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,temperature_2m,precipitation&wind_speed_unit=kmh&timezone=UTC";
        using var doc = JsonDocument.Parse(await http.GetStringAsync(url, ct));
        var hourly = doc.RootElement.GetProperty("hourly");
        var times = hourly.GetProperty("time").EnumerateArray().ToArray();
        double? Value(string name, int i) => hourly.GetProperty(name)[i].ValueKind == JsonValueKind.Null ? null : hourly.GetProperty(name)[i].GetDouble();
        var result = new List<HourlyWeather>();
        for (int i = 0; i < times.Length; i++)
        {
            double? wind = Value("wind_speed_10m", i), dir = Value("wind_direction_10m", i), rh = Value("relative_humidity_2m", i), temp = Value("temperature_2m", i);
            double? gust = Value("wind_gusts_10m", i), precip = Value("precipitation", i);
            if (wind is null || dir is null || rh is null || temp is null) continue;
            var ts = DateTimeOffset.Parse(times[i].GetString()! + ":00Z", inv, DateTimeStyles.AssumeUniversal);
            if (ts >= from && ts <= to) result.Add(new HourlyWeather(ts, wind.Value, dir.Value, rh.Value, temp.Value, provider, gust ?? 0, precip ?? 0));
        }
        return result;
    }

    async Task StoreAsync(string locationId, IEnumerable<HourlyWeather> items, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        foreach (var s in items)
            await connection.ExecuteAsync(@"INSERT INTO weather_obs(location_id,ts,provider,wind_kmh,wind_from,rh,temp_c,gust_kmh,precip_mm_h) VALUES (@loc,@ts,@provider,@w,@d,@rh,@t,@g,@p)
                ON CONFLICT (location_id,ts) DO UPDATE SET provider=@provider,wind_kmh=@w,wind_from=@d,rh=@rh,temp_c=@t,gust_kmh=@g,precip_mm_h=@p",
                new { loc = locationId, ts = s.Time.UtcDateTime, provider = s.Provider, w = (float)s.WindKmh, d = (float)s.WindFromDeg, rh = (float)s.HumidityPct, t = (float)s.TempC, g = (float)s.GustKmh, p = (float)s.PrecipitationMmH }, tx);
        await tx.CommitAsync(ct);
    }

    async Task<IReadOnlyList<HourlyWeather>> LoadAsync(string locationId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync("SELECT ts,provider,wind_kmh,wind_from,rh,temp_c,gust_kmh,precip_mm_h FROM weather_obs WHERE location_id=@loc AND ts BETWEEN @f AND @t ORDER BY ts",
            new { loc = locationId, f = from.UtcDateTime, t = to.UtcDateTime });
        return rows.Select(r => new HourlyWeather(new DateTimeOffset(DateTime.SpecifyKind((DateTime)r.ts, DateTimeKind.Utc)), (double)(float)r.wind_kmh, (double)(float)r.wind_from,
            (double)(float)r.rh, (double)(float)r.temp_c, (string)r.provider, (double)(float)r.gust_kmh, (double)(float)r.precip_mm_h)).ToList();
    }
}
