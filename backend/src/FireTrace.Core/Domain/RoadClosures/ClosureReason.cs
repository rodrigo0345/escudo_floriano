using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.RoadClosures;

public enum ClosureReason { FireActive, FirePredicted, SmokeVisibility, EvacuationRouteReserve, FirefightingOperations, TrafficManagement, InfrastructureDamage, Other }
