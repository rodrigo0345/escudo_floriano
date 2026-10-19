using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public enum VehicleStatus { Available, Assigned, Dispatched, EnRoute, OnScene, Returning, Refilling, OutOfService, Maintenance, Unavailable }
