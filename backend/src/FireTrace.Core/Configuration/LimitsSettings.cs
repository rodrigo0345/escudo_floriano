namespace FireTrace.Core.Configuration;

// Todos os valores de modelação, limites, endereços e tempos da API. Vivem em `appsettings.json` (secção FireTrace) e chegam ao código por estes
// records, ligados uma só vez ao arrancar. Não há valores por omissão: se faltar uma chave, a API não arranca.

public sealed record LimitsSettings(int MinDurationMinutes, int MaxDurationMinutes, int MinIgnitions, int MaxIgnitions, int MaxEnsembleMembers, int MaxKeyframes, int MaxActionsPerPlan,
    int MaxPageSize, int MaxWeatherDays, int MaxWaitSeconds, int MaxStepMinutes, int DefaultActionWindowMinutes, int ActionSmokeStepMinutes,
    int PlanRequestStaleMinutes, int MaxPlanRequestNoteLength,
    int RateLimitPermitLimit, int RateLimitWindowSeconds, int PlanningQueueLimit);
