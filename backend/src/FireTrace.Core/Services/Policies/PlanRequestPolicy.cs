using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Services.Crud;

namespace FireTrace.Core.Services.Policies;

/// <summary>Pedidos de planos: prefixo próprio (o `pla` por omissão é o dos planos).</summary>
public sealed class PlanRequestPolicy() : EntityPolicy<PlanRequest>("preq");
