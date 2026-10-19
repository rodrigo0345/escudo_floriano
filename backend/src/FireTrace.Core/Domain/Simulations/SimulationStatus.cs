using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Simulations;

public enum SimulationStatus { Queued, Running, Succeeded, Failed, Cancelled }
