using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

// ----------------------------------------------------------------------------------------------- viaturas
public enum VehicleType
{
    ForestFirefightingVehicle, LightFirefightingVehicle, UrbanFirefightingVehicle, TankerForest, TankerUrban, TankerLarge, CommandVehicle, CommandCommsVehicle,
    OperationsVehicle, RescueVehicle, Ambulance, AdvancedMedicalVehicle, ImmediateLifeSupportVehicle, PatrolCar, Motorcycle, TrafficUnit, AllTerrainPatrol,
    PersonnelTransport, Bus, Bulldozer, HeavyMachinery, TractorPlow, Helicopter, Airtanker, Drone, Other,
}
