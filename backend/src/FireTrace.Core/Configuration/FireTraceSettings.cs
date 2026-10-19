using FireTrace.Core.Domain.Fuel;
using FireTrace.Core.Domain.Rules;
using FireTrace.Engine.Configuration;

namespace FireTrace.Core.Configuration;

/// <summary>Tudo o que se configura em `FireTrace:*`, junto.</summary>
public sealed record FireTraceSettings(LimitsSettings Limits, DefaultsSettings Defaults, EngineSettings Engine, SimulationSettings Simulation, WeatherSettings Weather, List<FuelModel> Fuels,
    LandscapeSettings Landscape, ConvectionSettings Convection, NativeEngineSettings NativeEngine, FuelMoistureSettings FuelMoisture, InterventionSettings Interventions, AnalyticsSettings Analytics, SmokeSettings Smoke, RoutingSettings Routing, MapSettings Map,
    DispatchSettings Dispatch, RunStoreSettings RunStore, DatabaseSettings Database, Rules Rules)
{
    public static FireTraceSettings FromConfiguration(IConfiguration config) =>
        config.GetSection("FireTrace").Get<FireTraceSettings>() ?? throw new InvalidOperationException("Falta a secção FireTrace em appsettings.json.");

    /// <summary>Lê o `appsettings.json` da API (usado nos testes e em ferramentas fora do servidor).</summary>
    public static FireTraceSettings FromFile(string path) =>
        FromConfiguration(new ConfigurationBuilder().AddJsonFile(path, optional: false).Build());
}
