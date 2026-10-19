using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Resources;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record PersonnelRequest(PersonnelRole Role, int Quantity);
