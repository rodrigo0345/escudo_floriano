using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public enum VehicleCapability
{
    WildfireAttack, StructureProtection, WaterSupply, Rescue, Extrication, EvacuationTransport, MedicalTransport, AdvancedLifeSupport, TrafficControl, PerimeterSecurity,
    CommandAndControl, Communications, Reconnaissance, AerialWaterDrop, AerialRecon, HeavyEarthmoving, FirebreakConstruction, Logistics, Lighting, Hazmat,
}
