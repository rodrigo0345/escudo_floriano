namespace FireTrace.Core.Models.Meta;

public sealed record Capabilities(string ApiVersion, string ServerVersion, EngineInfo Engine, Limits Limits, IReadOnlyList<CapabilityItem> WeatherVariables,
    IReadOnlyList<CapabilityItem> WeatherEvents, IReadOnlyList<CapabilityItem> Interventions, IReadOnlyList<CapabilityItem> ActionTypes, IReadOnlyList<string> Locations);
