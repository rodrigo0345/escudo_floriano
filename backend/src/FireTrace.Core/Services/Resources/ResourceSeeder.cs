using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using Microsoft.Extensions.Logging;

namespace FireTrace.Core.Services.Resources;

/// <summary>
/// Semeia as organizações padrão (Bombeiros, GNR, INEM, Proteção Civil), os postos a partir
/// das instalações de emergência descobertas no mapa, e viaturas de combate e socorro associadas.
/// </summary>
public sealed class ResourceSeeder(
    IMapReader map,
    IDocumentStore<Organization> orgStore,
    IDocumentStore<Station> stationStore,
    IDocumentStore<Vehicle> vehicleStore,
    IDocumentStore<PersonnelPool> poolStore,
    IDocumentStore<Equipment> equipmentStore,
    TimeProvider clock,
    ILogger<ResourceSeeder> log)
{
    public async Task SeedAsync(CancellationToken ct = default)
    {
        var now = clock.GetUtcNow();

        // 1. Organizações de resposta a emergências em Portugal
        var defaultOrgs = new List<Organization>
        {
            new()
            {
                Id = "org-bombeiros",
                CreatedAt = now,
                UpdatedAt = now,
                Name = "Corpo de Bombeiros Voluntários",
                ShortName = "Bombeiros",
                Type = OrganizationType.FireBrigade,
                Active = true,
            },
            new()
            {
                Id = "org-gnr",
                CreatedAt = now,
                UpdatedAt = now,
                Name = "Guarda Nacional Republicana",
                ShortName = "GNR",
                Type = OrganizationType.Gnr,
                Active = true,
            },
            new()
            {
                Id = "org-inem",
                CreatedAt = now,
                UpdatedAt = now,
                Name = "Instituto Nacional de Emergência Médica",
                ShortName = "INEM",
                Type = OrganizationType.Inem,
                Active = true,
            },
            new()
            {
                Id = "org-prociv",
                CreatedAt = now,
                UpdatedAt = now,
                Name = "Autoridade Nacional de Emergência e Proteção Civil",
                ShortName = "ANEPC",
                Type = OrganizationType.CivilProtection,
                Active = true,
            }
        };

        foreach (var org in defaultOrgs)
        {
            var existing = await orgStore.GetAsync(org.Id, ct);
            await orgStore.UpsertAsync(existing is null ? org : org with { CreatedAt = existing.CreatedAt }, ct);
        }

        // 2. Bolsas de pessoal e equipamento padrão por organização
        var defaultPools = new List<PersonnelPool>
        {
            new()
            {
                Id = "pool-bombeiros",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                Role = PersonnelRole.Firefighter,
                Total = 40,
                Available = 35,
                Notes = "Equipas de intervenção florestal e combate urbano"
            },
            new()
            {
                Id = "pool-gnr",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-gnr",
                Role = PersonnelRole.GnrSoldier,
                Total = 24,
                Available = 20,
                Notes = "Militares GNR / UEPS para vigilância, corte de vias e ataque inicial"
            },
            new()
            {
                Id = "pool-inem",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-inem",
                Role = PersonnelRole.Paramedic,
                Total = 12,
                Available = 10,
                Notes = "Socorristas e equipas de emergência pré-hospitalar"
            }
        };

        foreach (var p in defaultPools)
        {
            var existing = await poolStore.GetAsync(p.Id, ct);
            await poolStore.UpsertAsync(existing is null ? p : p with { CreatedAt = existing.CreatedAt }, ct);
        }

        var defaultEq = new List<Equipment>
        {
            new()
            {
                Id = "eq-pumps",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                Kind = EquipmentKind.PortablePump,
                Label = "Motobombas portáteis de combate",
                Quantity = 8,
                Available = 8
            },
            new()
            {
                Id = "eq-hoses",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                Kind = EquipmentKind.HoseLine,
                Label = "Linhas de mangueira 45mm e 70mm",
                Quantity = 50,
                Available = 50
            },
            new()
            {
                Id = "eq-chainsaws",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                Kind = EquipmentKind.Chainsaw,
                Label = "Motosserras para corte de combustível",
                Quantity = 12,
                Available = 12
            },
            new()
            {
                Id = "eq-barriers",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-gnr",
                Kind = EquipmentKind.RoadBarrier,
                Label = "Barreiras de corte e sinalização de vias",
                Quantity = 40,
                Available = 40
            }
        };

        foreach (var eq in defaultEq)
        {
            var existing = await equipmentStore.GetAsync(eq.Id, ct);
            await equipmentStore.UpsertAsync(existing is null ? eq : eq with { CreatedAt = existing.CreatedAt }, ct);
        }

        // 3. Postos e viaturas para cada local a partir das instalações de emergência
        foreach (var location in map.Locations.All)
        {
            IReadOnlyList<Facility> facilities;
            try
            {
                facilities = await map.GetFacilitiesAsync(location.Id, ct);
            }
            catch
            {
                continue;
            }

            int stationCount = 0;
            int vehicleCount = 0;

            foreach (var fac in facilities)
            {
                (string? orgId, StationKind? stationKind) = fac.Kind switch
                {
                    FacilityKind.FireStation => ("org-bombeiros", (StationKind?)StationKind.FireStation),
                    FacilityKind.Gnr => ("org-gnr", (StationKind?)StationKind.GnrPost),
                    FacilityKind.Inem => ("org-inem", (StationKind?)StationKind.InemBase),
                    FacilityKind.Hospital => ("org-inem", (StationKind?)StationKind.InemBase),
                    FacilityKind.CivilProtection => ("org-prociv", (StationKind?)StationKind.CivilProtectionHq),
                    FacilityKind.Heliport => ("org-prociv", (StationKind?)StationKind.Helipad),
                    _ => ((string?)null, (StationKind?)null)
                };

                if (orgId is null || stationKind is null) continue;

                var pos = new LatLon(fac.Lat, fac.Lon);
                var stationId = $"st-{fac.Id}";
                var station = new Station
                {
                    Id = stationId,
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = orgId,
                    Name = fac.Name,
                    Kind = stationKind.Value,
                    LocationId = location.Id,
                    Position = pos,
                    FacilityId = fac.Id.ToString(),
                    VehicleBays = stationKind == StationKind.FireStation ? 6 : 4,
                    Status = StationStatus.Operational
                };

                var existingStation = await stationStore.GetAsync(stationId, ct);
                await stationStore.UpsertAsync(existingStation is null ? station : station with { CreatedAt = existingStation.CreatedAt }, ct);
                stationCount++;

                // Viaturas sediadas neste posto
                var stationVehicles = CreateVehiclesForStation(station, fac, now);
                foreach (var v in stationVehicles)
                {
                    var existingV = await vehicleStore.GetAsync(v.Id, ct);
                    await vehicleStore.UpsertAsync(existingV is null ? v : v with { CreatedAt = existingV.CreatedAt }, ct);
                    vehicleCount++;
                }
            }

            // Se o local não tiver nenhum quartel de bombeiros descoberto, cria um posto de referência
            if (stationCount == 0)
            {
                var fallbackStation = new Station
                {
                    Id = $"st-bombeiros-{location.Id}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-bombeiros",
                    Name = $"Bombeiros Voluntários ({location.Name})",
                    Kind = StationKind.FireStation,
                    LocationId = location.Id,
                    Position = location.Center,
                    VehicleBays = 6,
                    Status = StationStatus.Operational
                };
                var existingSt = await stationStore.GetAsync(fallbackStation.Id, ct);
                await stationStore.UpsertAsync(existingSt is null ? fallbackStation : fallbackStation with { CreatedAt = existingSt.CreatedAt }, ct);

                var vList = CreateVehiclesForStation(fallbackStation, null, now);
                foreach (var v in vList)
                {
                    var existingV = await vehicleStore.GetAsync(v.Id, ct);
                    await vehicleStore.UpsertAsync(existingV is null ? v : v with { CreatedAt = existingV.CreatedAt }, ct);
                    vehicleCount++;
                }
            }

            log.LogInformation("Recursos semeados para '{Location}': {Stations} postos, {Vehicles} viaturas.", location.Id, stationCount, vehicleCount);
        }
    }

    static List<Vehicle> CreateVehiclesForStation(Station st, Facility? fac, DateTimeOffset now)
    {
        var list = new List<Vehicle>();
        string idPrefix = fac is not null ? fac.Id.ToString() : st.LocationId;
        string suffix = fac is not null ? $"{fac.Id % 1000:D3}" : "01";

        if (st.Kind == StationKind.FireStation)
        {
            // VFCI - Veículo Florestal de Combate a Incêndios
            list.Add(new Vehicle
            {
                Id = $"v-vfci-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VFCI {suffix}",
                Type = VehicleType.ForestFirefightingVehicle,
                TypeCode = "VFCI",
                CrewCapacity = 5,
                MinimumCrew = 3,
                WaterCapacityL = 3500,
                FoamCapacityL = 100,
                PumpFlowLpm = 1500,
                OffRoad = true,
                MaxSlopePercent = 35,
                Capabilities = new() { VehicleCapability.WildfireAttack, VehicleCapability.StructureProtection, VehicleCapability.WaterSupply },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 5,
                    Water = new WaterStatus(3500, 3500),
                    UpdatedAt = now
                }
            });

            // VTTU - Veículo Tanque Tático Urbano/Florestal
            list.Add(new Vehicle
            {
                Id = $"v-vttu-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VTTU {suffix}",
                Type = VehicleType.TankerForest,
                TypeCode = "VTTU",
                CrewCapacity = 2,
                MinimumCrew = 2,
                WaterCapacityL = 10000,
                PumpFlowLpm = 2000,
                OffRoad = false,
                Capabilities = new() { VehicleCapability.WaterSupply },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    Water = new WaterStatus(10000, 10000),
                    UpdatedAt = now
                }
            });

            // VLCI - Veículo Ligeiro de Combate a Incêndios
            list.Add(new Vehicle
            {
                Id = $"v-vlci-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VLCI {suffix}",
                Type = VehicleType.LightFirefightingVehicle,
                TypeCode = "VLCI",
                CrewCapacity = 2,
                MinimumCrew = 2,
                WaterCapacityL = 600,
                PumpFlowLpm = 400,
                OffRoad = true,
                Capabilities = new() { VehicleCapability.WildfireAttack, VehicleCapability.Reconnaissance },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    Water = new WaterStatus(600, 600),
                    UpdatedAt = now
                }
            });
        }
        else if (st.Kind == StationKind.GnrPost)
        {
            // UEPS - Unidade de Emergência de Proteção e Socorro (GNR)
            list.Add(new Vehicle
            {
                Id = $"v-ueps-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"UEPS {suffix}",
                Type = VehicleType.AllTerrainPatrol,
                TypeCode = "UEPS",
                CrewCapacity = 4,
                MinimumCrew = 2,
                OffRoad = true,
                Capabilities = new() { VehicleCapability.WildfireAttack, VehicleCapability.TrafficControl, VehicleCapability.Reconnaissance },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 4,
                    UpdatedAt = now
                }
            });

            // BT - Destacamento de Trânsito
            list.Add(new Vehicle
            {
                Id = $"v-bt-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"GNR-BT {suffix}",
                Type = VehicleType.TrafficUnit,
                TypeCode = "BT",
                CrewCapacity = 2,
                MinimumCrew = 2,
                OffRoad = false,
                Capabilities = new() { VehicleCapability.TrafficControl, VehicleCapability.PerimeterSecurity },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    UpdatedAt = now
                }
            });
        }
        else if (st.Kind == StationKind.InemBase)
        {
            // ABSC - Ambulância de Socorro
            list.Add(new Vehicle
            {
                Id = $"v-absc-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"ABSC {suffix}",
                Type = VehicleType.Ambulance,
                TypeCode = "ABSC",
                CrewCapacity = 2,
                MinimumCrew = 2,
                StretcherCapacity = 1,
                Capabilities = new() { VehicleCapability.MedicalTransport, VehicleCapability.EvacuationTransport },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    UpdatedAt = now
                }
            });
        }
        else if (st.Kind == StationKind.CivilProtectionHq)
        {
            // PCO - Posto de Comando Operacional
            list.Add(new Vehicle
            {
                Id = $"v-pco-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"PCO {suffix}",
                Type = VehicleType.CommandVehicle,
                TypeCode = "PCO",
                CrewCapacity = 4,
                Capabilities = new() { VehicleCapability.CommandAndControl, VehicleCapability.Communications },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 4,
                    UpdatedAt = now
                }
            });
        }

        return list;
    }
}
