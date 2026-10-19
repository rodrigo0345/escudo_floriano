using FireTrace.Core.Domain.Dispatches;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Operations;

/// <summary>De onde vem um despacho: da API, de uma ação de um plano ativado ou de um operador.</summary>
public sealed record DispatchOrigin(DispatchSource Source = DispatchSource.Api, string? PlanId = null, IReadOnlyList<string?>? ActionIds = null);
