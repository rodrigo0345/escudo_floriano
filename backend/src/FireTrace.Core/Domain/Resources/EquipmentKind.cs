using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public enum EquipmentKind
{
    HoseLine, PortablePump, PortableWaterTank, Chainsaw, HandTools, PpeSet, BreathingApparatus, HandheldRadio, VehicleRadio, SatellitePhone, Generator,
    LightingTower, RoadBarrier, TrafficCone, RoadSign, ShelterTent, Stretcher, MedicalKit, Defibrillator, ThermalCamera, GpsTracker, Megaphone, Other,
}
