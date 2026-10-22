namespace FireTrace.Core.Configuration;

// Todos os valores de modelação, limites, endereços e tempos da API. Vivem em `appsettings.json` (secção FireTrace) e chegam ao código por estes
// records, ligados uma só vez ao arrancar. Não há valores por omissão: se faltar uma chave, a API não arranca.

public sealed record LimitsSettings(int MinDurationMinutes, int MaxDurationMinutes, int MinIgnitions, int MaxIgnitions, int MaxEnsembleMembers, int MaxKeyframes, int MaxActionsPerPlan,
    int MaxPageSize, int MaxWeatherDays, int MaxWaitSeconds, int MaxStepMinutes, int DefaultActionWindowMinutes, int ActionSmokeStepMinutes,
    int PlanRequestStaleMinutes, int MaxPlanRequestNoteLength,
    int RateLimitPermitLimit, int RateLimitWindowSeconds,
    // Endpoints pesados de planos (criar, validar, simular, corrigir): quantos correm ao mesmo tempo e quantos esperam a vez antes de levarem 429. O validador de planos usa o mesmo número.
    int PlanningPermitLimit, int PlanningQueueLimit,
    // Pedidos de planos aos agentes (criar, reclamar): leves, não devem esperar atrás de uma validação.
    int PlanRequestPermitLimit, int PlanRequestQueueLimit);
