using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Services.Crud;
using FireTrace.ExternalData.Store;

namespace FireTrace.Core.Services.Policies;

/// <summary>Cenários: o local tem de existir e os de exemplo (`builtin`) não se apagam.</summary>
public sealed class ScenarioPolicy(IMapReader map, LimitsSettings limits) : EntityPolicy<Scenario>("sc")
{
    public override Task<IEnumerable<ValidationIssue>> ValidateAsync(Scenario s, CancellationToken ct)
    {
        var issues = new List<ValidationIssue>();
        var loc = map.Locations.Find(s.LocationId);
        if (loc is null) issues.Add(new("error", "unknown_location", $"Local '{s.LocationId}' desconhecido.", "/locationId"));
        if (s.DurationMinutes < limits.MinDurationMinutes || s.DurationMinutes > limits.MaxDurationMinutes) issues.Add(new("error", "invalid_duration", $"durationMinutes deve estar entre {limits.MinDurationMinutes} e {limits.MaxDurationMinutes}.", "/durationMinutes"));
        if (s.Ignitions.Count < limits.MinIgnitions || s.Ignitions.Count > limits.MaxIgnitions) issues.Add(new("error", "invalid_ignitions", $"Indique entre {limits.MinIgnitions} e {limits.MaxIgnitions} ignições.", "/ignitions"));
        if (loc is not null)
            for (int i = 0; i < s.Ignitions.Count; i++)
                if (loc.Spec.CellAt(s.Ignitions[i].Position.Lat, s.Ignitions[i].Position.Lon) < 0) issues.Add(new("error", "ignition_outside", "A ignição está fora da área do local.", $"/ignitions/{i}/position"));
        if (s.Weather is { Base: WeatherBase.None, Keyframes: null or { Count: 0 } }) issues.Add(new("error", "missing_keyframes", "Com `base: none` é preciso pelo menos um ponto-chave.", "/weather/keyframes"));
        return Task.FromResult<IEnumerable<ValidationIssue>>(issues);
    }

    public override void EnsureDeletable(Scenario s)
    {
        if (s.Builtin) throw new ConflictException("Os cenários de exemplo não se podem apagar.", "builtin_scenario");
    }
}
