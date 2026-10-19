using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

// ----------------------------------------------------------------------------------------------- despachos
public enum DispatchStatus { Ordered, EnRoute, OnScene, Working, Refilling, Resting, Grounded, Returning, Completed, Cancelled, Failed }
