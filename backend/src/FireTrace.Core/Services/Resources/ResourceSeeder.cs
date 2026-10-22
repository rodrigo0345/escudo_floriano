using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Repositories;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Store;
using Microsoft.Extensions.Logging;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Resources;

/// <summary>
/// Semeia as organizações padrão (Bombeiros, GNR, INEM, Proteção Civil), os postos a partir
/// das instalações de emergência descobertas no mapa, viaturas associadas, cortes de via,
/// planos de resposta táticos operacionais (A e B) e despachos no terreno.
/// </summary>
public sealed class ResourceSeeder(
    IMapReader map,
    IDocumentStore<Organization> orgStore,
    IDocumentStore<Station> stationStore,
    IDocumentStore<Vehicle> vehicleStore,
    IDocumentStore<PersonnelPool> poolStore,
    IDocumentStore<Equipment> equipmentStore,
    IDocumentStore<RoadClosure> closureStore,
    IDocumentStore<Plan> planStore,
    IDocumentStore<Dispatch> dispatchStore,
    TimeProvider clock,
    ILogger<ResourceSeeder> log)
{
    static readonly GeometryFactory Gf = NetTopologySuite.NtsGeometryServices.Instance.CreateGeometryFactory(4326);
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
                Total = 280,
                Available = 250,
                Notes = "Equipas de intervenção florestal e combate urbano (Guimarães e concelhos limítrofes do Ave)"
            },
            new()
            {
                Id = "pool-bombeiros-florestal",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                Role = PersonnelRole.ForestFirefighter,
                Total = 80,
                Available = 75,
                Notes = "Equipas de Intervenção Permanente (EIP) e brigadas de combate florestal"
            },
            new()
            {
                Id = "pool-gnr",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-gnr",
                Role = PersonnelRole.GnrSoldier,
                Total = 90,
                Available = 80,
                Notes = "Militares GNR / Destacamento de Trânsito para corte de vias, evacuação forçada e perímetro"
            },
            new()
            {
                Id = "pool-gnr-ueps",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-gnr",
                Role = PersonnelRole.GnrSoldier,
                Total = 40,
                Available = 35,
                Notes = "Militares UEPS para ataque inicial, ações helitransportadas e reconhecimento tático"
            },
            new()
            {
                Id = "pool-inem",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-inem",
                Role = PersonnelRole.Paramedic,
                Total = 80,
                Available = 70,
                Notes = "Médicos VMER, Enfermeiros SIV, TEPH e equipas de emergência pré-hospitalar integradas"
            },
            new()
            {
                Id = "pool-inem-pma",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-inem",
                Role = PersonnelRole.Paramedic,
                Total = 30,
                Available = 25,
                Notes = "Equipas de Posto Médico Avançado (PMA), triagem em catástrofe e apoio psicológico CAPE/UMIPE"
            },
            new()
            {
                Id = "pool-prociv",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Role = PersonnelRole.CivilProtectionTechnician,
                Total = 450,
                Available = 420,
                Notes = "Força Operacional Conjunta da Proteção Civil / ANEPC e SMPC Guimarães (comando, apoio a evacuações e logística)"
            },
            new()
            {
                Id = "pool-sapadores",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Role = PersonnelRole.ForestFirefighter,
                Total = 70,
                Available = 65,
                Notes = "Brigadas de Sapadores Florestais (CIM do Ave / ICNF / CMG) para faixas corta-fogo, aceiros e rescaldo"
            },
            new()
            {
                Id = "pool-prociv-evac",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Role = PersonnelRole.CivilProtectionTechnician,
                Total = 90,
                Available = 85,
                Notes = "Técnicos de Ação Social, Cruz Vermelha e voluntários para gestão de centros de acolhimento e transporte de evacuados"
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
                Quantity = 30,
                Available = 30
            },
            new()
            {
                Id = "eq-hoses",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                Kind = EquipmentKind.HoseLine,
                Label = "Linhas de mangueira 45mm e 70mm",
                Quantity = 250,
                Available = 250
            },
            new()
            {
                Id = "eq-chainsaws",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                Kind = EquipmentKind.Chainsaw,
                Label = "Motosserras para corte de combustível e abertura de faixas",
                Quantity = 40,
                Available = 40
            },
            new()
            {
                Id = "eq-barriers",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-gnr",
                Kind = EquipmentKind.RoadBarrier,
                Label = "Barreiras de corte e sinalização de vias",
                Quantity = 120,
                Available = 120
            },
            new()
            {
                Id = "eq-anepc-shelter",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Kind = EquipmentKind.ShelterTent,
                Label = "Tendas de acolhimento e abrigo de emergência para deslocados",
                Quantity = 60,
                Available = 60,
                Notes = "Estruturas de montagem rápida para centros de apoio temporário aos cidadãos evacuados"
            },
            new()
            {
                Id = "eq-anepc-stretchers",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Kind = EquipmentKind.Stretcher,
                Label = "Macas de evacuação e transporte de feridos/acamados",
                Quantity = 80,
                Available = 80,
                Notes = "Macas de campo e colheres de resgate para evacuação de cidadãos com mobilidade reduzida"
            },
            new()
            {
                Id = "eq-anepc-megaphones",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Kind = EquipmentKind.Megaphone,
                Label = "Megafones de aviso sonoro e orientação de evacuação",
                Quantity = 40,
                Available = 40,
                Notes = "Megafones com sirene integrada para aviso porta-a-porta e orientação de evacuação"
            },
            new()
            {
                Id = "eq-anepc-barriers",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Kind = EquipmentKind.RoadBarrier,
                Label = "Barreiras móveis de balizamento e controlo de zona de evacuação",
                Quantity = 150,
                Available = 150,
                Notes = "Delimitação de corredores de segurança e pontos de concentração de evacuados"
            },
            new()
            {
                Id = "eq-anepc-medical-kit",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Kind = EquipmentKind.MedicalKit,
                Label = "Malas de primeiros socorros para postos de acolhimento",
                Quantity = 75,
                Available = 75,
                Notes = "Estojos com material de penso, oxigénio e hidratação para apoio às pessoas evacuadas"
            },
            new()
            {
                Id = "eq-generator-lights",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Kind = EquipmentKind.LightingTower,
                Label = "Torres de iluminação e geradores para apoio noturno",
                Quantity = 20,
                Available = 20
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
            var seenKinds = new HashSet<StationKind>();

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
                seenKinds.Add(stationKind.Value);

                var pos = new LatLon(fac.Lat, fac.Lon);
                var stationId = $"st-{fac.Id}";
                var bays = stationKind.Value switch
                {
                    StationKind.FireStation => 14,
                    StationKind.CivilProtectionHq => 20,
                    StationKind.InemBase => 12,
                    StationKind.GnrPost => 10,
                    _ => 6
                };
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
                    VehicleBays = bays,
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

            // Assegura postos e viaturas para TODAS as organizações essenciais caso o mapa/OSM não as tenha descoberto
            async Task EnsureFallbackStation(Station st)
            {
                var existingSt = await stationStore.GetAsync(st.Id, ct);
                await stationStore.UpsertAsync(existingSt is null ? st : st with { CreatedAt = existingSt.CreatedAt }, ct);
                stationCount++;

                var vList = CreateVehiclesForStation(st, null, now);
                foreach (var v in vList)
                {
                    var existingV = await vehicleStore.GetAsync(v.Id, ct);
                    await vehicleStore.UpsertAsync(existingV is null ? v : v with { CreatedAt = existingV.CreatedAt }, ct);
                    vehicleCount++;
                }
            }

            if (!seenKinds.Contains(StationKind.FireStation))
            {
                await EnsureFallbackStation(new Station
                {
                    Id = $"st-bombeiros-{location.Id}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-bombeiros",
                    Name = $"Bombeiros Voluntários ({location.Name})",
                    Kind = StationKind.FireStation,
                    LocationId = location.Id,
                    Position = location.Center,
                    VehicleBays = 14,
                    Status = StationStatus.Operational
                });
            }

            if (!seenKinds.Contains(StationKind.GnrPost))
            {
                await EnsureFallbackStation(new Station
                {
                    Id = $"st-gnr-{location.Id}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-gnr",
                    Name = $"GNR — Destacamento Territorial ({location.Name})",
                    Kind = StationKind.GnrPost,
                    LocationId = location.Id,
                    Position = new LatLon(location.Center.Lat + 0.003, location.Center.Lon + 0.003),
                    VehicleBays = 10,
                    Status = StationStatus.Operational
                });
            }

            if (!seenKinds.Contains(StationKind.InemBase))
            {
                await EnsureFallbackStation(new Station
                {
                    Id = $"st-inem-{location.Id}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-inem",
                    Name = $"INEM / Hospital Distrital ({location.Name})",
                    Kind = StationKind.InemBase,
                    LocationId = location.Id,
                    Position = new LatLon(location.Center.Lat + 0.004, location.Center.Lon - 0.006),
                    VehicleBays = 12,
                    Status = StationStatus.Operational
                });
            }

            if (!seenKinds.Contains(StationKind.CivilProtectionHq))
            {
                await EnsureFallbackStation(new Station
                {
                    Id = $"st-prociv-{location.Id}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-prociv",
                    Name = $"Serviço Municipal de Proteção Civil ({location.Name})",
                    Kind = StationKind.CivilProtectionHq,
                    LocationId = location.Id,
                    Position = new LatLon(location.Center.Lat - 0.003, location.Center.Lon - 0.002),
                    VehicleBays = 20,
                    Status = StationStatus.Operational
                });
            }

            // CMA - Centro de Meios Aéreos com esquadrilha completa (helicópteros pesados, ligeiros e coordenação)
            var heliStation = new Station
            {
                Id = $"st-cma-{location.Id}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Name = $"Centro de Meios Aéreos ({location.Name})",
                Kind = StationKind.Helipad,
                LocationId = location.Id,
                Position = new LatLon(location.Center.Lat + 0.005, location.Center.Lon - 0.005),
                VehicleBays = 6,
                Status = StationStatus.Operational
            };
            var existingHeliSt = await stationStore.GetAsync(heliStation.Id, ct);
            await stationStore.UpsertAsync(existingHeliSt is null ? heliStation : heliStation with { CreatedAt = existingHeliSt.CreatedAt }, ct);
            stationCount++;

            var airFleet = new List<Vehicle>
            {
                new()
                {
                    Id = $"v-hebp-{location.Id}-01",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-prociv",
                    StationId = heliStation.Id,
                    Callsign = "HEBP 01",
                    Type = VehicleType.Helicopter,
                    TypeCode = "UH-60A",
                    CrewCapacity = 3,
                    MinimumCrew = 2,
                    OffRoad = true,
                    CruiseSpeedKmh = 260,
                    RangeKm = 580,
                    FuelCapacityL = 1360,
                    WaterCapacityL = 3000,
                    PumpFlowLpm = 6000,
                    Capabilities = new() { VehicleCapability.AerialWaterDrop, VehicleCapability.AerialRecon },
                    Aerial = new AerialSpec(BucketCapacityL: 3000, LoadMinutes: 1.0, DropMinutes: 0.5, CruiseSpeedKmh: 260, MaxWindKmh: 50, MinVisibilityM: 2000, DayOnly: true),
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = heliStation.Position,
                        CrewOnboard = 2,
                        Water = new WaterStatus(3000, 3000),
                        UpdatedAt = now
                    }
                },
                new()
                {
                    Id = $"v-hebp-{location.Id}-02",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-prociv",
                    StationId = heliStation.Id,
                    Callsign = "HEBP 02",
                    Type = VehicleType.Helicopter,
                    TypeCode = "Ka-32A11BC",
                    CrewCapacity = 3,
                    MinimumCrew = 2,
                    OffRoad = true,
                    CruiseSpeedKmh = 240,
                    RangeKm = 650,
                    FuelCapacityL = 2400,
                    WaterCapacityL = 4500,
                    PumpFlowLpm = 7500,
                    Capabilities = new() { VehicleCapability.AerialWaterDrop, VehicleCapability.AerialRecon },
                    Aerial = new AerialSpec(BucketCapacityL: 4500, LoadMinutes: 1.5, DropMinutes: 0.6, CruiseSpeedKmh: 240, MaxWindKmh: 55, MinVisibilityM: 2000, DayOnly: true),
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = heliStation.Position,
                        CrewOnboard = 2,
                        Water = new WaterStatus(4500, 4500),
                        UpdatedAt = now
                    }
                },
                new()
                {
                    Id = $"v-hebl-{location.Id}-01",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-bombeiros",
                    StationId = heliStation.Id,
                    Callsign = "HEBL 01",
                    Type = VehicleType.Helicopter,
                    TypeCode = "AS350B3",
                    CrewCapacity = 5,
                    MinimumCrew = 1,
                    OffRoad = true,
                    CruiseSpeedKmh = 250,
                    RangeKm = 650,
                    FuelCapacityL = 540,
                    WaterCapacityL = 1000,
                    PumpFlowLpm = 3000,
                    Capabilities = new() { VehicleCapability.AerialWaterDrop, VehicleCapability.AerialRecon },
                    Aerial = new AerialSpec(BucketCapacityL: 1000, LoadMinutes: 0.7, DropMinutes: 0.3, CruiseSpeedKmh: 250, MaxWindKmh: 45, MinVisibilityM: 2000, DayOnly: true),
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = heliStation.Position,
                        CrewOnboard = 2,
                        Water = new WaterStatus(1000, 1000),
                        UpdatedAt = now
                    }
                },
                new()
                {
                    Id = $"v-hebl-{location.Id}-02",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-bombeiros",
                    StationId = heliStation.Id,
                    Callsign = "HEBL 02",
                    Type = VehicleType.Helicopter,
                    TypeCode = "Bell-412",
                    CrewCapacity = 6,
                    MinimumCrew = 2,
                    OffRoad = true,
                    CruiseSpeedKmh = 230,
                    RangeKm = 700,
                    FuelCapacityL = 1200,
                    WaterCapacityL = 1500,
                    PumpFlowLpm = 4000,
                    Capabilities = new() { VehicleCapability.AerialWaterDrop, VehicleCapability.AerialRecon },
                    Aerial = new AerialSpec(BucketCapacityL: 1500, LoadMinutes: 0.8, DropMinutes: 0.4, CruiseSpeedKmh: 230, MaxWindKmh: 50, MinVisibilityM: 2000, DayOnly: true),
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = heliStation.Position,
                        CrewOnboard = 2,
                        Water = new WaterStatus(1500, 1500),
                        UpdatedAt = now
                    }
                },
                new()
                {
                    Id = $"v-heco-{location.Id}-01",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = "org-prociv",
                    StationId = heliStation.Id,
                    Callsign = "HECO 01",
                    Type = VehicleType.Helicopter,
                    TypeCode = "EC135",
                    CrewCapacity = 4,
                    MinimumCrew = 2,
                    OffRoad = true,
                    CruiseSpeedKmh = 250,
                    RangeKm = 635,
                    FuelCapacityL = 700,
                    Capabilities = new() { VehicleCapability.AerialRecon, VehicleCapability.CommandAndControl, VehicleCapability.Communications },
                    Aerial = new AerialSpec(BucketCapacityL: 0, LoadMinutes: 0, DropMinutes: 0, CruiseSpeedKmh: 250, MaxWindKmh: 55, MinVisibilityM: 1500, DayOnly: true),
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = heliStation.Position,
                        CrewOnboard = 2,
                        UpdatedAt = now
                    }
                }
            };

            foreach (var h in airFleet)
            {
                var existingH = await vehicleStore.GetAsync(h.Id, ct);
                await vehicleStore.UpsertAsync(existingH is null ? h : h with { CreatedAt = existingH.CreatedAt }, ct);
                vehicleCount++;
            }

            log.LogInformation("Recursos semeados para '{Location}': {Stations} postos, {Vehicles} viaturas.", location.Id, stationCount, vehicleCount);
        }

        // 4. Cortes de estrada operacionais
        var penhaRoadClosure = new RoadClosure
        {
            Id = "clo-penha-access",
            CreatedAt = now,
            UpdatedAt = now,
            LocationId = "guimaraes",
            RoadIds = new() { "rd-penha-access" },
            Geometry = Gf.CreateLineString(new[] { new Coordinate(-8.2686, 41.4298), new Coordinate(-8.2710, 41.4320) }),
            Kind = ClosureKind.Full,
            Reason = ClosureReason.FirePredicted,
            Status = ClosureStatus.Active,
            Start = now.AddHours(-1),
            End = now.AddHours(5),
            ResponsibleOrganizationId = "org-gnr",
            Source = "police",
            Notes = "Corte total preventivo na via de subida à Penha devido a incêndio florestal."
        };
        var existingClosure = await closureStore.GetAsync(penhaRoadClosure.Id, ct);
        await closureStore.UpsertAsync(existingClosure is null ? penhaRoadClosure : penhaRoadClosure with { CreatedAt = existingClosure.CreatedAt }, ct);

        // 5. Planos e despachos: já não se semeiam. Os planos vêm dos agentes (um par A/B por pedido): um plano de demonstração fixo, Ativo e sempre de volta no arranque,
        //    aparecia ao lado do plano mais recente e gastava o operador (e os tokens dos agentes) com planos que ninguém pediu.

        log.LogInformation("Cortes de via operacionais semeados com sucesso (sem planos nem despachos de demonstração).");
    }

    static List<Vehicle> CreateVehiclesForStation(Station st, Facility? fac, DateTimeOffset now)
    {
        var list = new List<Vehicle>();
        string idPrefix = fac is not null ? fac.Id.ToString() : st.Id.Replace("st-", "");
        string suffix = fac is not null ? $"{fac.Id % 1000:D3}" : "01";

        if (st.Kind == StationKind.FireStation)
        {
            // VFCI - 4 Veículos Florestais de Combate a Incêndios (Ataque direto e proteção de estruturas)
            for (int i = 1; i <= 4; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-vfci-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VFCI {suffix}-{i:D2}",
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
            }

            // VTTU - 2 Veículos Tanque Tático (Abastecimento de água e combate pesado)
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-vttu-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VTTU {suffix}-{i:D2}",
                    Type = VehicleType.TankerForest,
                    TypeCode = "VTTU",
                    CrewCapacity = 2,
                    MinimumCrew = 2,
                    WaterCapacityL = i == 1 ? 10000 : 12000,
                    PumpFlowLpm = 2000,
                    OffRoad = false,
                    Capabilities = new() { VehicleCapability.WaterSupply, VehicleCapability.WildfireAttack },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 2,
                        Water = new WaterStatus(i == 1 ? 10000 : 12000, i == 1 ? 10000 : 12000),
                        UpdatedAt = now
                    }
                });
            }

            // VLCI - 2 Veículos Ligeiros de Combate a Incêndios 4x4 (Ataque inicial rápido e reconhecimento)
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-vlci-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VLCI {suffix}-{i:D2}",
                    Type = VehicleType.LightFirefightingVehicle,
                    TypeCode = "VLCI",
                    CrewCapacity = 3,
                    MinimumCrew = 2,
                    WaterCapacityL = 800,
                    PumpFlowLpm = 500,
                    OffRoad = true,
                    Capabilities = new() { VehicleCapability.WildfireAttack, VehicleCapability.Reconnaissance },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 3,
                        Water = new WaterStatus(800, 800),
                        UpdatedAt = now
                    }
                });
            }

            // VCOT - Veículo de Comando Operacional Tático
            list.Add(new Vehicle
            {
                Id = $"v-vcot-{idPrefix}-01",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VCOT {suffix}",
                Type = VehicleType.CommandVehicle,
                TypeCode = "VCOT",
                CrewCapacity = 4,
                MinimumCrew = 2,
                OffRoad = true,
                Capabilities = new() { VehicleCapability.CommandAndControl, VehicleCapability.Reconnaissance },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 3,
                    UpdatedAt = now
                }
            });

            // ABSC - 2 Ambulâncias de Socorro do Corpo de Bombeiros (Apoio aos operacionais e emergência)
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-absc-bv-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"ABSC-BV {suffix}-{i:D2}",
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
        }
        else if (st.Kind == StationKind.GnrPost)
        {
            // UEPS - 3 Unidades de Emergência de Proteção e Socorro (GNR) 4x4
            for (int i = 1; i <= 3; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-ueps-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"UEPS {suffix}-{i:D2}",
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
            }

            // BT - 3 Viaturas de Trânsito / Patrulha Territorial (Cortes de via e segurança)
            for (int i = 1; i <= 3; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-bt-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"GNR-BT {suffix}-{i:D2}",
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

            // VRR - Viatura de Reconhecimento Rápido GNR 4x4
            list.Add(new Vehicle
            {
                Id = $"v-vrr-{idPrefix}-01",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"GNR-VRR {suffix}",
                Type = VehicleType.PatrolCar,
                TypeCode = "VRR",
                CrewCapacity = 2,
                MinimumCrew = 2,
                OffRoad = true,
                Capabilities = new() { VehicleCapability.Reconnaissance, VehicleCapability.TrafficControl },
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
            // VMER - Viatura Médica de Emergência e Reanimação (Médico + Enfermeiro)
            list.Add(new Vehicle
            {
                Id = $"v-vmer-{idPrefix}-01",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VMER {suffix}",
                Type = VehicleType.AdvancedMedicalVehicle,
                TypeCode = "VMER",
                CrewCapacity = 2,
                MinimumCrew = 2,
                CruiseSpeedKmh = 140,
                OffRoad = false,
                Capabilities = new() { VehicleCapability.MedicalTransport, VehicleCapability.AdvancedLifeSupport, VehicleCapability.CommandAndControl },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    UpdatedAt = now
                }
            });

            // SIV - Suporte Imediato de Vida (Enfermeiro + TEPH)
            list.Add(new Vehicle
            {
                Id = $"v-siv-{idPrefix}-01",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"SIV {suffix}",
                Type = VehicleType.ImmediateLifeSupportVehicle,
                TypeCode = "SIV",
                CrewCapacity = 2,
                MinimumCrew = 2,
                CruiseSpeedKmh = 130,
                OffRoad = false,
                Capabilities = new() { VehicleCapability.MedicalTransport, VehicleCapability.AdvancedLifeSupport },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    UpdatedAt = now
                }
            });

            // ABSC - 6 Ambulâncias de Socorro do INEM (Prevenção e Transporte Sanitário)
            for (int i = 1; i <= 6; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-absc-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"ABSC {suffix}-{i:D2}",
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

            // PMA - Posto Médico Avançado Móvel (Triagem e Catástrofe)
            list.Add(new Vehicle
            {
                Id = $"v-pma-{idPrefix}-01",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"PMA {suffix}",
                Type = VehicleType.OperationsVehicle,
                TypeCode = "PMA",
                CrewCapacity = 4,
                MinimumCrew = 2,
                OffRoad = false,
                Capabilities = new() { VehicleCapability.MedicalTransport, VehicleCapability.CommandAndControl, VehicleCapability.Logistics },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 4,
                    UpdatedAt = now
                }
            });

            // UMIPE - Unidade Móvel de Intervenção Psicológica de Emergência
            list.Add(new Vehicle
            {
                Id = $"v-umipe-{idPrefix}-01",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"UMIPE {suffix}",
                Type = VehicleType.CommandVehicle,
                TypeCode = "UMIPE",
                CrewCapacity = 2,
                MinimumCrew = 2,
                OffRoad = false,
                Capabilities = new() { VehicleCapability.Logistics, VehicleCapability.Communications },
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
            // PCO - Posto de Comando Operacional Móvel
            list.Add(new Vehicle
            {
                Id = $"v-pco-{idPrefix}-01",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"PCO {suffix}",
                Type = VehicleType.CommandVehicle,
                TypeCode = "PCO",
                CrewCapacity = 6,
                Capabilities = new() { VehicleCapability.CommandAndControl, VehicleCapability.Communications, VehicleCapability.Logistics },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 5,
                    UpdatedAt = now
                }
            });

            // VCOT - 2 Veículos de Comando Operacional Tático 4x4
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-vcot-pc-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VCOT-PC {suffix}-{i:D2}",
                    Type = VehicleType.CommandVehicle,
                    TypeCode = "VCOT",
                    CrewCapacity = 4,
                    OffRoad = true,
                    CruiseSpeedKmh = 130,
                    Capabilities = new() { VehicleCapability.CommandAndControl, VehicleCapability.Reconnaissance },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 2,
                        UpdatedAt = now
                    }
                });
            }

            // VETA - 2 Veículos Especiais de Telecomunicações e Apoio
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-veta-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VETA {suffix}-{i:D2}",
                    Type = VehicleType.CommandCommsVehicle,
                    TypeCode = "VETA",
                    CrewCapacity = 4,
                    Capabilities = new() { VehicleCapability.Communications, VehicleCapability.Reconnaissance },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 2,
                        UpdatedAt = now
                    }
                });
            }

            // VTTP - 4 Veículos Táticos de Transporte de Pessoal / Sapadores Florestais (9 operacionais cada)
            for (int i = 1; i <= 4; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-vttp-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VTTP {suffix}-{i:D2}",
                    Type = VehicleType.PersonnelTransport,
                    TypeCode = "VTTP",
                    CrewCapacity = 9,
                    PassengerCapacity = 8,
                    OffRoad = true,
                    CruiseSpeedKmh = 110,
                    Capabilities = new() { VehicleCapability.EvacuationTransport, VehicleCapability.Logistics, VehicleCapability.StructureProtection },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 9,
                        UpdatedAt = now
                    }
                });
            }

            // AUTOCARRO - 3 Autocarros de Evacuação de Populações (55 passageiros cada = 165 evacuações por vaga)
            for (int i = 1; i <= 3; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-bus-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"AUTOCARRO {suffix}-{i:D2}",
                    Type = VehicleType.Bus,
                    TypeCode = "AUTOCARRO",
                    CrewCapacity = 2,
                    MinimumCrew = 1,
                    PassengerCapacity = 55,
                    OffRoad = false,
                    CruiseSpeedKmh = 95,
                    RangeKm = 900,
                    FuelCapacityL = 280,
                    Capabilities = new() { VehicleCapability.EvacuationTransport, VehicleCapability.Logistics },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 2,
                        FuelPct = 100,
                        UpdatedAt = now
                    }
                });
            }

            // ABEV - 3 Ambulâncias de Evacuação Múltipla / Transporte de Acamados
            for (int i = 1; i <= 3; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-abev-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"ABEV {suffix}-{i:D2}",
                    Type = VehicleType.Ambulance,
                    TypeCode = "ABEV",
                    CrewCapacity = 3,
                    MinimumCrew = 2,
                    StretcherCapacity = 4,
                    PassengerCapacity = 6,
                    OffRoad = false,
                    CruiseSpeedKmh = 110,
                    RangeKm = 750,
                    FuelCapacityL = 85,
                    Capabilities = new() { VehicleCapability.EvacuationTransport, VehicleCapability.MedicalTransport, VehicleCapability.Rescue },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 3,
                        FuelPct = 90,
                        UpdatedAt = now
                    }
                });
            }

            // DRONE - 2 Equipas de Drones de Reconhecimento Térmico e Rastreio
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-drone-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"DRONE {suffix}-{i:D2}",
                    Type = VehicleType.Drone,
                    TypeCode = "DRONE",
                    CrewCapacity = 2,
                    MinimumCrew = 1,
                    OffRoad = true,
                    CruiseSpeedKmh = 80,
                    RangeKm = 30,
                    Capabilities = new() { VehicleCapability.AerialRecon, VehicleCapability.Reconnaissance },
                    Aerial = new AerialSpec(BucketCapacityL: 0, LoadMinutes: 0, DropMinutes: 0, CruiseSpeedKmh: 80, MaxWindKmh: 40, MinVisibilityM: 500, DayOnly: false),
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 2,
                        UpdatedAt = now
                    }
                });
            }

            // VFCI-SF - 2 Veículos Florestais dos Sapadores Florestais Municipais (Combate e faixa)
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-vfci-sf-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VFCI-SF {suffix}-{i:D2}",
                    Type = VehicleType.ForestFirefightingVehicle,
                    TypeCode = "VFCI-SF",
                    CrewCapacity = 5,
                    MinimumCrew = 3,
                    WaterCapacityL = 3500,
                    PumpFlowLpm = 1200,
                    OffRoad = true,
                    MaxSlopePercent = 35,
                    Capabilities = new() { VehicleCapability.WildfireAttack, VehicleCapability.StructureProtection, VehicleCapability.WaterSupply, VehicleCapability.FirebreakConstruction },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 5,
                        Water = new WaterStatus(3500, 3500),
                        UpdatedAt = now
                    }
                });
            }

            // VLC-PC - Veículo Ligeiro de Coordenação e Reconhecimento 4x4
            list.Add(new Vehicle
            {
                Id = $"v-vlc-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VLC-PC {suffix}",
                Type = VehicleType.AllTerrainPatrol,
                TypeCode = "VLC",
                CrewCapacity = 4,
                MinimumCrew = 2,
                PassengerCapacity = 3,
                OffRoad = true,
                MaxSlopePercent = 50,
                CruiseSpeedKmh = 120,
                RangeKm = 800,
                FuelCapacityL = 80,
                Capabilities = new() { VehicleCapability.CommandAndControl, VehicleCapability.Reconnaissance, VehicleCapability.Logistics },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    FuelPct = 100,
                    UpdatedAt = now
                }
            });

            // MR-PC - Máquina de Rasto para abertura de faixas corta-fogo
            list.Add(new Vehicle
            {
                Id = $"v-mr-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"MR-PC {suffix}",
                Type = VehicleType.Bulldozer,
                TypeCode = "MR",
                CrewCapacity = 1,
                MinimumCrew = 1,
                OffRoad = true,
                MaxSlopePercent = 60,
                CruiseSpeedKmh = 12,
                RangeKm = 100,
                FuelCapacityL = 350,
                Capabilities = new() { VehicleCapability.HeavyEarthmoving, VehicleCapability.FirebreakConstruction },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 1,
                    FuelPct = 100,
                    UpdatedAt = now
                }
            });

            // VTTG - Veículo Tanque Tático de Grande Capacidade da Proteção Civil (15.000 L)
            list.Add(new Vehicle
            {
                Id = $"v-vttg-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VTTG {suffix}",
                Type = VehicleType.TankerLarge,
                TypeCode = "VTTG",
                CrewCapacity = 2,
                MinimumCrew = 2,
                WaterCapacityL = 15000,
                PumpFlowLpm = 2500,
                OffRoad = false,
                CruiseSpeedKmh = 80,
                RangeKm = 600,
                FuelCapacityL = 300,
                Capabilities = new() { VehicleCapability.WaterSupply, VehicleCapability.Logistics },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    Water = new WaterStatus(15000, 15000),
                    FuelPct = 100,
                    UpdatedAt = now
                }
            });

            // VMAT - 2 Veículos de Apoio Logístico a Centros de Acolhimento e Evacuação
            for (int i = 1; i <= 2; i++)
            {
                list.Add(new Vehicle
                {
                    Id = $"v-vmat-{idPrefix}-{i:D2}",
                    CreatedAt = now,
                    UpdatedAt = now,
                    OrganizationId = st.OrganizationId,
                    StationId = st.Id,
                    Callsign = $"VMAT {suffix}-{i:D2}",
                    Type = VehicleType.OperationsVehicle,
                    TypeCode = "VMAT",
                    CrewCapacity = 3,
                    MinimumCrew = 2,
                    OffRoad = false,
                    Capabilities = new() { VehicleCapability.Logistics, VehicleCapability.EvacuationTransport },
                    State = new()
                    {
                        Status = VehicleStatus.Available,
                        Position = st.Position,
                        CrewOnboard = 3,
                        UpdatedAt = now
                    }
                });
            }

            // VLOG - Veículo de Apoio Logístico e Iluminação
            list.Add(new Vehicle
            {
                Id = $"v-vlog-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VLOG {suffix}",
                Type = VehicleType.OperationsVehicle,
                TypeCode = "VLOG",
                CrewCapacity = 3,
                MinimumCrew = 1,
                OffRoad = true,
                CruiseSpeedKmh = 100,
                RangeKm = 700,
                FuelCapacityL = 90,
                Capabilities = new() { VehicleCapability.Logistics, VehicleCapability.Lighting },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    FuelPct = 90,
                    UpdatedAt = now
                }
            });
        }

        return list;
    }
}
