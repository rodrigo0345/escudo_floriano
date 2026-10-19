using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Resources;
using FireTrace.ExternalData.Map;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Operations;

/// <summary>Que capacidades de uma viatura servem cada responsabilidade (`FireTrace:Dispatch:ResponsibilityCapabilities`).</summary>
public sealed class ResponsibilityRules(DispatchSettings settings)
{
    readonly Dictionary<Responsibility, VehicleCapability[]> _needs = settings.ResponsibilityCapabilities.ToDictionary(
        kv => EnumText.Parse<Responsibility>(kv.Key), kv => kv.Value.Select(EnumText.Parse<VehicleCapability>).ToArray());

    /// <summary>Uma viatura sem capacidades declaradas serve para tudo, e uma responsabilidade sem lista (`standby`) serve qualquer viatura.</summary>
    public bool Supports(Responsibility responsibility, IReadOnlyCollection<VehicleCapability>? capabilities) =>
        capabilities is not { Count: > 0 } || !_needs.TryGetValue(responsibility, out var needed) || needed.Any(capabilities.Contains);
}
