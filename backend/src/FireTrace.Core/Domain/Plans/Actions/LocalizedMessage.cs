using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

public sealed record LocalizedMessage(string Language, string Text);
