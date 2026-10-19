using FireTrace.Core.Domain.Weather;

namespace FireTrace.Core.Models.Weather;

public sealed record WeatherResolveRequest(string LocationId, DateTimeOffset Start, int DurationMinutes, WeatherSpec Weather, int? StepMinutes = null);
