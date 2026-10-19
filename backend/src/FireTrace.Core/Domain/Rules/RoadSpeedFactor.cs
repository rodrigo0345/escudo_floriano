namespace FireTrace.Core.Domain.Rules;

// As regras e os valores que o servidor usa para mover os meios e gastar recursos. Só leitura (`GET /rules`): quem decide fica a saber o que esperar.

public sealed record RoadSpeedFactor(string Highway, double Factor);
