using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Fuel;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Services.Fire;
using FireTrace.Core.Services.Operations;
using FireTrace.Core.Services.Routing;

namespace FireTrace.Tests.Support;

/// <summary>Os testes usam os mesmos valores que a API: os do `appsettings.json` do repositório (não há valores escondidos no código).</summary>
static class TestSettings
{
    public static readonly string Root = FindRoot();
    public static readonly FireTraceSettings All = FireTraceSettings.FromFile(Path.Combine(Root, "src", "FireTrace.Core", "appsettings.json"));

    public static FuelCatalog Fuels => new(All.Fuels);
    public static LandscapeBuilder Landscape => new(All.Landscape, Fuels);
    /// <summary>A paisagem sem variabilidade: para comparar uma causa de cada vez (vento, vegetação, barreira) sem o ruído.</summary>
    public static LandscapeBuilder FlatLandscape => new(All.Landscape with { SpreadVariability = All.Landscape.SpreadVariability with { Amplitude = 0 } }, Fuels);
    public static RoadSpeeds Speeds => new(All.Routing, All.Rules);
    public static ResponsibilityRules Responsibilities => new(All.Dispatch);

    static string FindRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "FireTrace.sln"))) return d.FullName;
        throw new InvalidOperationException("FireTrace.sln não encontrado a partir de " + AppContext.BaseDirectory);
    }
}
