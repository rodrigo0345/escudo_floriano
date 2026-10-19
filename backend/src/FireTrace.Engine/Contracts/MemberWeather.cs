using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Contracts;

/// <summary>A meteorologia de um membro do ensemble, a propagação própria (barreiras galgadas) e, se o fogo já o alterou, o vento por bloco.</summary>
public sealed record MemberWeather(string Name, WeatherTrack Weather, float[]? Adjustment = null, WindField? Wind = null);
