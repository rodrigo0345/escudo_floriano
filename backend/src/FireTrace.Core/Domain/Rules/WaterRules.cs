namespace FireTrace.Core.Domain.Rules;

/// <summary>Água das viaturas. `AttackFlowLpm` é o caudal máximo das linhas de ataque: a trabalhar gasta-se `min(bomba, AttackFlowLpm) × DutyCycle` por minuto.</summary>
public sealed record WaterRules(string ConsumptionLpm, double DutyCycle, double AttackFlowLpm, RefillRules Refill)
{
    /// <summary>Litros por minuto que uma viatura com esta bomba gasta a trabalhar (0 sem bomba).</summary>
    public double WorkingLpm(double pumpLpm) => pumpLpm <= 0 ? 0 : (AttackFlowLpm > 0 ? Math.Min(pumpLpm, AttackFlowLpm) : pumpLpm) * DutyCycle;
}
