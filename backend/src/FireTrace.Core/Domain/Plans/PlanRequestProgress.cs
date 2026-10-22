namespace FireTrace.Core.Domain.Plans;

/// <summary>Em que passo vai o agente (`composing`, `judging`, `simulating`…), com uma frase para o operador.</summary>
public sealed record PlanRequestProgress(string Phase, double Percent, string? Message = null);
