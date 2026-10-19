using System.Collections.Concurrent;

namespace FireTrace.Core.Models.Fire;

/// <summary>Pontos e período a consultar. Sem `ToMin` consulta-se só o instante `FromMin`; com `ToMin`, uma série de `StepMin` em `StepMin` minutos.</summary>
public sealed record SmokeQuery(List<SmokePointRef> Points, int? FromMin = null, int? ToMin = null, int? StepMin = null);
