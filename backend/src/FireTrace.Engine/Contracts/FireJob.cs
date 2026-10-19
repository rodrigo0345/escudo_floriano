using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Contracts;

/// <summary>Tudo o que o motor precisa para uma corrida.</summary>
public sealed record FireJob(EngineGrid Spec, short[] Landscape, float[] Adjustment, IReadOnlyList<IgnitionCell> Ignitions, int Minutes,
    IReadOnlyList<MemberWeather> Members, int SpinUpMinutes, bool Spotting, bool[]? BurnedAtStart = null, FuelMoistureSpec? FuelMoisture = null,
    Action<int, int>? Progress = null);
