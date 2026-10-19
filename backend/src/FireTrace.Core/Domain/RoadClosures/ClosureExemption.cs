using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.RoadClosures;

public enum ClosureExemption { EmergencyVehicles, Residents, Utilities, Media, Agricultural }
