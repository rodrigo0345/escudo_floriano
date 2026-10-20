using System.Globalization;
using System.Text.Json;
using System.Text;
using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Storage;
using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Elmfire;

/// <summary>The shared job folder: writes a job's inputs for the container (landscape, adjustments, weather per member, meta) and reads the results back.</summary>
public sealed class ElmfireJobFiles(ElmfireOptions options, FuelMoistureSettings moisture, NativeEngineSettings native)
{
    public async Task WriteInputsAsync(string dir, FireJob job, CancellationToken ct)
    {
        int bands = job.Minutes * 60 / options.MetIntervalSeconds + 2;
        await File.WriteAllBytesAsync(Path.Combine(dir, "landscape.i16"), BinaryArrays.ToBytes(job.Landscape), ct);
        await File.WriteAllBytesAsync(Path.Combine(dir, "adj.f32"), BinaryArrays.ToBytes(job.Adjustment), ct);
        if (job.BurnedAtStart is { } burned) await File.WriteAllBytesAsync(Path.Combine(dir, "phi0.u8"), burned.Select(b => (byte)(b ? 1 : 0)).ToArray(), ct);
        foreach (var member in job.Members)
        {
            await File.WriteAllTextAsync(Path.Combine(dir, $"wx_{member.Name}.csv"), WeatherCsv(member, job, bands), ct);
            if (member.Adjustment is { } adjustment) await File.WriteAllBytesAsync(Path.Combine(dir, $"adj_{member.Name}.f32"), BinaryArrays.ToBytes(adjustment), ct);
            if (member.Wind is { } wind) await File.WriteAllBytesAsync(Path.Combine(dir, $"wind_{member.Name}.f32"), BinaryArrays.ToBytes(wind.SpeedKmh.Concat(wind.FromDeg).ToArray()), ct);
        }
        await File.WriteAllTextAsync(Path.Combine(dir, "meta.json"), JsonSerializer.Serialize(Meta(job)), ct);
    }

    public IReadOnlyDictionary<string, FireResult> ReadResults(string dir, FireJob job, JsonElement members)
    {
        var results = new Dictionary<string, FireResult>();
        foreach (var member in job.Members)
        {
            var info = members.GetProperty(member.Name);
            if (info.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String) throw new EngineUnavailableException($"ELMFIRE ({member.Name}): {error.GetString()}");
            string memberDir = Path.Combine(dir, member.Name);
            results[member.Name] = new FireResult
            {
                Ignition = BinaryArrays.FromBytes<short>(File.ReadAllBytes(Path.Combine(memberDir, "toa.i16"))).Select(v => (int)v).ToArray(),
                IntensityKwm = BinaryArrays.FromBytes<ushort>(File.ReadAllBytes(Path.Combine(memberDir, "flin.u16"))),
                Flags = File.ReadAllBytes(Path.Combine(memberDir, "crown.u8")).Select(v => v > 0 ? (byte)1 : (byte)0).ToArray(),
            };
        }
        return results;
    }

    string WeatherCsv(MemberWeather member, FireJob job, int bands)
    {
        var csv = new StringBuilder("ws,wd,m1,m10,m100,lh,lw\n");
        int stepMinutes = Math.Max(1, options.MetIntervalSeconds / 60);
        // O ELMFIRE não tem campo de rajada: entra na velocidade do vento com o mesmo peso que tem no motor nativo, para as duas
        // física verem o mesmo vento efetivo (uma rajada a 40 km/h com 25 km/h de vento médio não pode ser ignorada pelo level set).
        foreach (var (row, k) in DeadFuelMoisture.Series(member.Weather, options.MetIntervalSeconds, bands, moisture, job.SpinUpMinutes, job.FuelMoisture).Select((r, k) => (r, k)))
        {
            double gustKmh = member.Weather.At(k * stepMinutes).GustKmh;
            double windKmh = gustKmh > row.Ws ? row.Ws + native.GustFactor * (gustKmh - row.Ws) : row.Ws;
            csv.AppendLine(string.Join(',', new[] { windKmh, row.Wd, row.M1, row.M10, row.M100, row.Lh, row.Lw }.Select(v => v.ToString("0.###", CultureInfo.InvariantCulture))));
        }
        return csv.ToString();
    }

    object Meta(FireJob job)
    {
        var spotting = options.Spotting;
        var windGrid = job.Members.Select(m => m.Wind).FirstOrDefault(w => w is not null);
        return new
        {
            w = job.Spec.Width, h = job.Spec.Height, cell_m = job.Spec.CellM, tstop_s = job.Minutes * 60, dt_met_s = options.MetIntervalSeconds,
            ignitions = job.Ignitions.Select(i => new[] { i.X, i.Y, i.StartSeconds }), members = job.Members.Select(m => m.Name), spotting = job.Spotting,
            foliar_pct = job.FuelMoisture?.Values?.FoliarPct ?? native.DefaultFoliarMoisturePct,
            spotting_params = new
            {
                critical_intensity_kwm = spotting.CriticalFirelineIntensityKwm, pign = spotting.PignPct, pign_min = spotting.PignMinPct, pign_max = spotting.PignMaxPct,
                ember_gr = spotting.EmberGenerationRate, tau_embergen = spotting.TauEmberGenSeconds, ember_sampling_factor = spotting.EmberSamplingFactor,
                surface_pct_min = spotting.SurfaceFireSpottingPercentMin, surface_pct_max = spotting.SurfaceFireSpottingPercentMax,
                min_spotting_distance_m = spotting.MinSpottingDistanceM, max_spotting_distance_m = spotting.MaxSpottingDistanceM,
            },
            wind = windGrid is null ? null : new { cols = windGrid.Cols, rows = windGrid.Rows, cell_m = windGrid.CellM },
        };
    }
}
