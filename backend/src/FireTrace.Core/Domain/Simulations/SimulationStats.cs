using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Simulations;

public sealed record SimulationStats(double BurnedHa, double CrownFireHa, double MaxIntensityKwm, int BuildingsAffected, int? CrewCasualties = null);
