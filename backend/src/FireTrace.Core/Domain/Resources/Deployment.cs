using System.Text.Json;
using FireTrace.Core.Domain.Dispatches;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record Deployment(Responsibility Responsibility, int Personnel);
