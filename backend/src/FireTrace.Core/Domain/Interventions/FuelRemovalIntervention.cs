using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Interventions;

/// <summary>Corte de árvores/mato numa faixa: muda o combustível das células da faixa (sem copado, com menos carga ou sem combustível), não só a velocidade.</summary>
public sealed record FuelRemovalIntervention : Intervention { public required Geometry Geometry { get; init; } public double? WidthM { get; init; } public required FuelRemoval Removal { get; init; } public string? Method { get; init; } public int? ConstructionMinutes { get; init; } }
