using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Meta;
using FireTrace.Core.Models.Weather;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Store;
using FireTrace.ExternalData.Weather;

namespace FireTrace.Core.Services.Weather;

/// <summary>Meteorologia real de um local e a meteorologia programada de um cenário.</summary>
public sealed class WeatherService(IWeatherSource source, IMapReader map, FireTraceSettings settings)
{
    /// <summary>As horas de aquecimento do combustível antes do início: as do cenário ou as por omissão.</summary>
    public int SpinUpHours(WeatherSpec spec) => spec.SpinUpHours ?? settings.Defaults.SpinUpHours;

    public async Task<WeatherSeries> SeriesAsync(string locationId, DateTimeOffset from, DateTimeOffset to, int stepMinutes, CancellationToken ct = default)
    {
        if (to <= from || (to - from).TotalDays > settings.Limits.MaxWeatherDays) throw new ValidationException($"Intervalo inválido (máximo {settings.Limits.MaxWeatherDays} dias).");
        var loc = map.Locations.Get(locationId);
        var hourly = await source.GetHourlyAsync(locationId, loc.WeatherPoint, from, to, ct);
        var samples = hourly.Where((_, i) => i % Math.Max(1, stepMinutes / 60) == 0).Select(h => h.ToSample()).ToList();
        return new WeatherSeries(locationId, samples, from, to, Math.Max(60, stepMinutes), new List<string> { "Open-Meteo (ERA5 / previsão)" });
    }

    /// <summary>A série contínua de uma simulação (com período de aquecimento), a partir da receita do cenário.</summary>
    public async Task<WeatherTrack> BuildTrackAsync(string locationId, WeatherSpec spec, DateTimeOffset start, int durationMinutes, CancellationToken ct = default)
    {
        IReadOnlyList<WeatherSample> hourly = Array.Empty<WeatherSample>();
        if (spec.Base == WeatherBase.Provider)
        {
            var point = spec.Provider?.Point ?? map.Locations.Get(locationId).WeatherPoint;
            var pad = settings.Weather.Timeline;
            hourly = (await source.GetHourlyAsync(locationId, point, start.AddHours(-SpinUpHours(spec) - pad.ProviderPaddingBeforeHours), start.AddMinutes(durationMinutes).AddHours(pad.ProviderPaddingAfterHours), ct)).Select(h => h.ToSample()).ToList();
        }
        else if (spec.Keyframes is not { Count: > 0 }) throw new ValidationException("Com `base: none` é preciso pelo menos um ponto-chave.", "/weather/keyframes");
        return WeatherTimeline.Build(spec, hourly, start, durationMinutes, settings.Weather.Timeline, SpinUpHours(spec), spec.Provider?.Point ?? map.Locations.Get(locationId).WeatherPoint);
    }

    /// <summary>Pré-visualização: a série efetiva (com eventos e humidade do combustível), sem correr o motor.</summary>
    public async Task<WeatherResolveResponse> ResolveAsync(WeatherResolveRequest req, CancellationToken ct = default)
    {
        var limits = settings.Limits;
        if (req.DurationMinutes < limits.MinDurationMinutes || req.DurationMinutes > limits.MaxDurationMinutes)
            throw new ValidationException($"durationMinutes deve estar entre {limits.MinDurationMinutes} e {limits.MaxDurationMinutes}.", "/durationMinutes");
        map.Locations.Get(req.LocationId);
        var step = Math.Clamp(req.StepMinutes ?? settings.Defaults.WeatherStepMinutes, 1, limits.MaxStepMinutes);
        var track = await BuildTrackAsync(req.LocationId, req.Weather, req.Start, req.DurationMinutes, ct);
        int n = req.DurationMinutes / step + 1;
        var fuel = DeadFuelMoisture.Series(track, step * 60, n, settings.FuelMoisture, SpinUpHours(req.Weather) * 60, req.Weather.FuelMoisture);
        var samples = Enumerable.Range(0, n).Select(i =>
        {
            var p = track.At(i * step);
            var f = fuel[i];
            return p.ToSample(req.Start.AddMinutes(i * step), "scenario") with { FuelMoisture = new FuelMoisture(Math.Round(f.M1, 1), Math.Round(f.M10, 1), Math.Round(f.M100, 1), f.Lh, f.Lw) };
        }).ToList();

        var spec = ResolvedEnsemble.Of(req.Weather.Ensemble, settings.Defaults.Ensemble);
        var members = Ensemble.Members(track, spec, Math.Min(spec.Members, settings.Defaults.EnsemblePreviewMembers), limits.MaxEnsembleMembers);
        EnsemblePreview? preview = null;
        if (members.Count > 0)
        {
            var winds = Enumerable.Range(0, n).Select(i => members.Select(m => m.Weather.At(i * step).WindKmh).OrderBy(x => x).ToArray()).ToArray();
            preview = new EnsemblePreview(winds.Select(w => Math.Round(w[(int)(w.Length * 0.1)], 1)).ToList(), winds.Select(w => Math.Round(w[Math.Min(w.Length - 1, (int)(w.Length * 0.9))], 1)).ToList(), spec.WindDirectionSigmaDeg);
        }
        var warnings = new List<ValidationIssue>();
        if (req.Weather.Events?.OfType<WindShiftEvent>().Any(e => e.ToDeg is null && e.DeltaDeg is null) == true)
            warnings.Add(new("warning", "wind_shift_without_target", "Um `wind_shift` sem `toDeg` nem `deltaDeg` não altera o vento."));
        return new WeatherResolveResponse(req.LocationId, req.Start, req.DurationMinutes, step, samples, preview, warnings);
    }
}
