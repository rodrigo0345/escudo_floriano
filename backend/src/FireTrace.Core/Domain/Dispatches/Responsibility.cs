using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

// O que se decide e se faz: despachar meios com pessoas e uma responsabilidade, e os planos (A e B) com as ações de cada organização.

public enum Responsibility { Firefighting, StructureProtection, WaterSupply, Evacuation, TrafficControl, PerimeterSecurity, Medical, Rescue, Command, Reconnaissance, Logistics, Standby }
