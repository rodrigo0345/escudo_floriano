using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Domain.Weather;

namespace FireTrace.Core.Models.Weather;

public sealed record WeatherResolveResponse(string LocationId, DateTimeOffset Start, int DurationMinutes, int StepMinutes, IReadOnlyList<WeatherSample> Samples,
    EnsemblePreview? Ensemble = null, IReadOnlyList<ValidationIssue>? Warnings = null, IReadOnlyList<WeatherEvent>? Events = null, IReadOnlyList<WeatherKeyframe>? Keyframes = null);
