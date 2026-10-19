using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.RoadClosures;

public enum ClosureKind { Full, PartialLane, OneWayOnly, ConvoyOnly, EmergencyOnly }
