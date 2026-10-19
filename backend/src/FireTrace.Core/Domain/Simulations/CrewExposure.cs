using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Domain.Simulations;

/// <summary>Uma equipa de uma ação do plano que passa tempo numa célula a arder (a caminho ou no local): as baixas saem das regras de equipas.</summary>
public sealed record CrewExposure(string ActionId, string VehicleId, int Personnel, int FirstMinute, int MinutesInFire, int Casualties, LatLon? Where = null);
