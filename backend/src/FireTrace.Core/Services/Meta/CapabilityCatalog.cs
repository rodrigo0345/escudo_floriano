using FireTrace.Core.Configuration;
using FireTrace.Core.Models.Meta;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Services.Meta;

/// <summary>O que o servidor suporta de facto, para o frontend desativar opções e os clientes escolherem alternativas.</summary>
public static class CapabilityCatalog
{
    static CapabilityItem Yes(string name, string? note = null) => new(name, true, note);
    static CapabilityItem No(string name, string note) => new(name, false, note);

    public static Capabilities Build(IEnumerable<string> locations, LimitsSettings limits) => new("1", typeof(CapabilityCatalog).Assembly.GetName().Version?.ToString() ?? "0",
        new("ELMFIRE", License: "Commons Clause"), new(limits.MaxDurationMinutes, limits.MaxIgnitions, limits.MaxEnsembleMembers, limits.MaxKeyframes, limits.MaxActionsPerPlan),
        WeatherVariables: new[]
        {
            Yes("windKmh"), Yes("windFromDeg"), Yes("tempC"), Yes("humidityPct"), Yes("gustKmh", "só informativa: o motor usa o vento médio"),
            Yes("precipitationMmH", "aumenta a humidade relativa"), No("pressureHpa", "aceite mas não usada"), No("cloudCoverPct", "aceite mas não usada"), No("hainesIndex", "aceite mas não usada"),
        },
        WeatherEvents: new[]
        {
            Yes("wind_shift"), Yes("wind_scale"), Yes("wind_set"), Yes("gust_burst"), Yes("front_passage"), Yes("temperature_shift"), Yes("humidity_shift"),
            Yes("precipitation"), Yes("custom_series"),
        },
        Interventions: new[]
        {
            Yes("fire_line", "aplica-se desde o início da simulação"), Yes("fuel_removal", "muda o combustível da faixa (sem copado, sem sub-bosque ou solo nu); aplica-se desde o início"), Yes("crew_deployment", "aplica-se desde o início da simulação"), Yes("aerial_drop", "aplica-se desde o início da simulação"),
            Yes("structure_protection", "reduz os edifícios contados como afetados"), Yes("road_closure", "afeta acessos e rotas, não o fogo"), Yes("evacuation", "afeta a população exposta, não o fogo"),
            No("backfire", "ainda não modelado"),
        },
        ActionTypes: Enum.GetNames<ActionTypeName>().Select(n => Yes(EnumText.ToSnake(Enum.Parse<ActionTypeName>(n)))).ToList(),
        Locations: locations.ToList());

    /// <summary>Os tipos de ação do contrato (todos aceites; só alguns têm efeito no fogo).</summary>
    enum ActionTypeName { DispatchUnits, StageResources, EstablishCommandPost, RoadClosure, TrafficControlPoint, Evacuation, ShelterInPlace, StructureProtection, FireAttack, FuelBreak, MedicalStandby, AirSupportRequest, PublicAlert, RequestReinforcements, Reconnaissance, Custom }
}
