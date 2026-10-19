using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Resources;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.RoadClosures;

public sealed record EquipmentNeed(EquipmentKind Kind, int Quantity);
