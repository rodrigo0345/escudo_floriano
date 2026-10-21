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
            },
            new()
            {
                Id = "pool-prociv",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Role = PersonnelRole.CivilProtectionTechnician,
                Total = 300,
                Available = 300,
                Notes = "Força Operacional Conjunta da Proteção Civil / ANEPC (300 operacionais disponíveis para comando, combate, apoio e evacuação)"
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
            },
            new()
            {
                Id = "eq-anepc-shelter",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-prociv",
                Kind = EquipmentKind.ShelterTent,
                Label = "Tendas de acolhimento e abrigo de emergência para deslocados",
                Quantity = 20,
                Available = 20,
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
                Quantity = 30,
                Available = 30,
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
                Quantity = 15,
                Available = 15,
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
                Quantity = 50,
                Available = 50,
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
                Quantity = 25,
                Available = 25,
                Notes = "Estojos com material de penso, oxigénio e hidratação para apoio às pessoas evacuadas"
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

            // 2 helicópteros de combate a incêndios por omissão (CMA - Centro de Meios Aéreos)
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
                VehicleBays = 4,
                Status = StationStatus.Operational
            };
            var existingHeliSt = await stationStore.GetAsync(heliStation.Id, ct);
            await stationStore.UpsertAsync(existingHeliSt is null ? heliStation : heliStation with { CreatedAt = existingHeliSt.CreatedAt }, ct);
            stationCount++;

            var heli1 = new Vehicle
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
            };
            var existingHeli1 = await vehicleStore.GetAsync(heli1.Id, ct);
            await vehicleStore.UpsertAsync(existingHeli1 is null ? heli1 : heli1 with { CreatedAt = existingHeli1.CreatedAt }, ct);
            vehicleCount++;

            var heli2 = new Vehicle
            {
                Id = $"v-hebl-{location.Id}-02",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = "org-bombeiros",
                StationId = heliStation.Id,
                Callsign = "HEBL 02",
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
            };
            var existingHeli2 = await vehicleStore.GetAsync(heli2.Id, ct);
            await vehicleStore.UpsertAsync(existingHeli2 is null ? heli2 : heli2 with { CreatedAt = existingHeli2.CreatedAt }, ct);
            vehicleCount++;

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

        // 5. Planos de Resposta Operacionais (Plano A e Plano B)
        var planA = new Plan
        {
            Id = "plan-penha-a",
            CreatedAt = now,
            UpdatedAt = now,
            LocationId = "guimaraes",
            Title = "Plano A — Ataque Inicial Direto e Contenção de Flancos",
            Variant = "A",
            Strategy = "Ataque direto ao flanco esquerdo com linhas de mangueira e autotanques, corte preventivo de vias e vigilância UEPS",
            Summary = "Mobilização rápida de equipas de combate para conter a cabeça do incêndio na Penha antes da linha de cumeada, estabelecendo perímetro de segurança.",
            Basis = new PlanBasis(ScenarioId: "sc-penha-pior-hora-2026", SituationAsOf: now),
            AlertLevel = AlertLevel.Orange,
            Status = PlanStatus.Active,
            ActivatedAt = now.AddMinutes(-30),
            Objectives = new()
            {
                new("Proteger aglomerados habitacionais e santuário da Penha", 0.9),
                new("Conter a progressão do flanco esquerdo na encosta oeste", 0.8)
            },
            Actions = new()
            {
                new FireAttackAction
                {
                    Id = "act-penha-a1",
                    Title = "Ataque direto ao flanco com linhas de mangueira 45mm",
                    OrganizationId = "org-bombeiros",
                    SupportingOrganizationIds = new() { "org-gnr" },
                    Priority = ActionPriority.Critical,
                    Status = ActionStatus.InProgress,
                    Tactic = "Ataque direto e ancoragem",
                    AnchorPoint = new LatLon(41.4305, -8.2690),
                    Objective = "Travar avanço do fogo em direção ao parque de campismo",
                    ExpectedDurationMinutes = 120,
                    Progress = new ActionProgress(StartedAt: now.AddMinutes(-25), Note: "Combate ativo com 1 linha de 45mm")
                },
                new RoadClosureAction
                {
                    Id = "act-penha-a2",
                    Title = "Corte de trânsito na subida à Penha",
                    OrganizationId = "org-gnr",
                    Priority = ActionPriority.High,
                    Status = ActionStatus.InProgress,
                    RoadIds = new() { "rd-penha-access" },
                    Kind = ClosureKind.Full,
                    Reason = ClosureReason.FirePredicted,
                    ClosureId = "clo-penha-access",
                    Progress = new ActionProgress(StartedAt: now.AddMinutes(-30), Note: "Via cortada e sinalizada")
                },
                new MedicalStandbyAction
                {
                    Id = "act-penha-a3",
                    Title = "Prontidão médica pré-hospitalar no Posto Médico Avançado",
                    OrganizationId = "org-inem",
                    Priority = ActionPriority.High,
                    Status = ActionStatus.InProgress,
                    Positions = new() { new Target(Label: "PMA Penha", Position: new LatLon(41.4320, -8.2725)) },
                    HospitalAlert = "Hospital Senhora da Oliveira (Guimarães)",
                    Progress = new ActionProgress(StartedAt: now.AddMinutes(-20), Note: "PMA operacional")
                },
                new StructureProtectionAction
                {
                    Id = "act-penha-a4",
                    Title = "Proteção perimetral do Santuário e Parque de Campismo",
                    OrganizationId = "org-bombeiros",
                    Priority = ActionPriority.Normal,
                    Status = ActionStatus.Planned,
                    Targets = new() { new Target(Label: "Santuário da Penha", Position: new LatLon(41.4300, -8.2700)) },
                    Tactic = "Cortina de proteção e arrefecimento de estruturas"
                }
            }
        };
        var existingPlanA = await planStore.GetAsync(planA.Id, ct);
        await planStore.UpsertAsync(existingPlanA is null ? planA : planA with { CreatedAt = existingPlanA.CreatedAt }, ct);

        var planB = new Plan
        {
            Id = "plan-penha-b",
            CreatedAt = now,
            UpdatedAt = now,
            LocationId = "guimaraes",
            Title = "Plano B — Contenção Indireta e Faixas de Gestão de Combustível",
            Variant = "B",
            Strategy = "Contenção indireta apoiada na rede de faixas corta-fogo, estabelecimento de PCO municipal e pontos de controlo de tráfego GNR",
            Summary = "Estratégia defensiva de contingência: recuo para faixas corta-fogo consolidadas com abertura de aceiros e controlo rigoroso de acessos.",
            Basis = new PlanBasis(ScenarioId: "sc-penha-pior-hora-2026", SituationAsOf: now),
            AlertLevel = AlertLevel.Red,
            Status = PlanStatus.Proposed,
            Objectives = new()
            {
                new("Criar linha de paragem em aceiro estratégico", 0.85),
                new("Evacuação preventiva de pontos vulneráveis", 0.95)
            },
            Actions = new()
            {
                new EstablishCommandPostAction
                {
                    Id = "act-penha-b1",
                    Title = "Instalação do Posto de Comando Operacional (PCO) Conjunto",
                    OrganizationId = "org-prociv",
                    Priority = ActionPriority.Critical,
                    Status = ActionStatus.Planned,
                    Location = new Target(Label: "Campo de São Mamede / PCO", Position: new LatLon(41.4475, -8.2910)),
                    RadioChannel = "SIRESP-CANAL-EMERG-GMR-01"
                },
                new FuelBreakAction
                {
                    Id = "act-penha-b2",
                    Title = "Consolidação e limpeza da faixa corta-fogo sul",
                    OrganizationId = "org-bombeiros",
                    Priority = ActionPriority.High,
                    Status = ActionStatus.Planned,
                    Line = Gf.CreateLineString(new[] { new Coordinate(-8.2670, 41.4280), new Coordinate(-8.2720, 41.4300) }),
                    Removal = Core.Domain.Interventions.FuelRemoval.Understory,
                    WidthM = 15
                },
                new TrafficControlPointAction
                {
                    Id = "act-penha-b3",
                    Title = "Ponto de controlo de trânsito e triagem de moradores",
                    OrganizationId = "org-gnr",
                    Priority = ActionPriority.High,
                    Status = ActionStatus.Planned,
                    Position = new LatLon(41.4330, -8.2740),
                    Mode = "resident_access_only",
                    Instructions = "Apenas moradores com comprovativo e veículos de socorro"
                },
                new PublicAlertAction
                {
                    Id = "act-penha-b4",
                    Title = "Aviso à população para confinamento e encerramento de acessos",
                    OrganizationId = "org-prociv",
                    Priority = ActionPriority.High,
                    Status = ActionStatus.Planned,
                    Channels = new() { "sms", "siren", "broadcast" },
                    Messages = new()
                    {
                        new("pt", "Aviso Proteção Civil Guimarães: Incêndio florestal ativo na Penha. Evite a circulação nas imediações e siga as instruções das autoridades.")
                    }
                }
            }
        };
        var existingPlanB = await planStore.GetAsync(planB.Id, ct);
        await planStore.UpsertAsync(existingPlanB is null ? planB : planB with { CreatedAt = existingPlanB.CreatedAt }, ct);

        // 6. Despachos ativos associados ao Plano A
        var allVehicles = await vehicleStore.ListAsync(ct);
        var vfci = allVehicles.FirstOrDefault(v => v.Type == VehicleType.ForestFirefightingVehicle);
        if (vfci is not null)
        {
            var dispVfci = new Dispatch
            {
                Id = "disp-vfci-penha",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = vfci.OrganizationId,
                ResourceType = ResourceType.Vehicle,
                ResourceId = vfci.Id,
                Personnel = vfci.CrewCapacity,
                Responsibility = Responsibility.Firefighting,
                Target = new Target(Label: "Flanco Sul da Penha", Position: new LatLon(41.4305, -8.2690)),
                FromStationId = vfci.StationId,
                Status = DispatchStatus.OnScene,
                PlanId = "plan-penha-a",
                ActionId = "act-penha-a1",
                ArrivedAt = now.AddMinutes(-20),
                StartAt = now.AddMinutes(-30),
                Water = new WaterStatus(3000, 3500),
                Notes = "Combate direto ao flanco com 5 operacionais e linha de 45mm."
            };
            var existingDisp = await dispatchStore.GetAsync(dispVfci.Id, ct);
            await dispatchStore.UpsertAsync(existingDisp is null ? dispVfci : dispVfci with { CreatedAt = existingDisp.CreatedAt }, ct);

            await vehicleStore.UpsertAsync(vfci with
            {
                State = vfci.State with
                {
                    Status = VehicleStatus.Assigned,
                    Responsibility = Responsibility.Firefighting,
                    CurrentPlanId = "plan-penha-a",
                    CurrentActionId = "act-penha-a1",
                    CurrentDispatchId = dispVfci.Id,
                    UpdatedAt = now
                }
            }, ct);
        }

        var gnrVeh = allVehicles.FirstOrDefault(v => v.Type == VehicleType.TrafficUnit);
        if (gnrVeh is not null)
        {
            var dispGnr = new Dispatch
            {
                Id = "disp-gnr-penha",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = gnrVeh.OrganizationId,
                ResourceType = ResourceType.Vehicle,
                ResourceId = gnrVeh.Id,
                Personnel = gnrVeh.CrewCapacity,
                Responsibility = Responsibility.TrafficControl,
                Target = new Target(Label: "Corte de Via Penha Norte", Position: new LatLon(41.4330, -8.2740)),
                FromStationId = gnrVeh.StationId,
                Status = DispatchStatus.OnScene,
                PlanId = "plan-penha-a",
                ActionId = "act-penha-a2",
                ArrivedAt = now.AddMinutes(-25),
                StartAt = now.AddMinutes(-30),
                Notes = "Corte e sinalização de trânsito com 2 militares."
            };
            var existingDisp = await dispatchStore.GetAsync(dispGnr.Id, ct);
            await dispatchStore.UpsertAsync(existingDisp is null ? dispGnr : dispGnr with { CreatedAt = existingDisp.CreatedAt }, ct);

            await vehicleStore.UpsertAsync(gnrVeh with
            {
                State = gnrVeh.State with
                {
                    Status = VehicleStatus.Assigned,
                    Responsibility = Responsibility.TrafficControl,
                    CurrentPlanId = "plan-penha-a",
                    CurrentActionId = "act-penha-a2",
                    CurrentDispatchId = dispGnr.Id,
                    UpdatedAt = now
                }
            }, ct);
        }

        var inemVeh = allVehicles.FirstOrDefault(v => v.Type == VehicleType.Ambulance);
        if (inemVeh is not null)
        {
            var dispInem = new Dispatch
            {
                Id = "disp-inem-penha",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = inemVeh.OrganizationId,
                ResourceType = ResourceType.Vehicle,
                ResourceId = inemVeh.Id,
                Personnel = inemVeh.CrewCapacity,
                Responsibility = Responsibility.Medical,
                Target = new Target(Label: "PMA Penha", Position: new LatLon(41.4320, -8.2725)),
                FromStationId = inemVeh.StationId,
                Status = DispatchStatus.OnScene,
                PlanId = "plan-penha-a",
                ActionId = "act-penha-a3",
                ArrivedAt = now.AddMinutes(-18),
                StartAt = now.AddMinutes(-25),
                Notes = "Prontidão socorrista no Posto Médico Avançado."
            };
            var existingDisp = await dispatchStore.GetAsync(dispInem.Id, ct);
            await dispatchStore.UpsertAsync(existingDisp is null ? dispInem : dispInem with { CreatedAt = existingDisp.CreatedAt }, ct);

            await vehicleStore.UpsertAsync(inemVeh with
            {
                State = inemVeh.State with
                {
                    Status = VehicleStatus.Assigned,
                    Responsibility = Responsibility.Medical,
                    CurrentPlanId = "plan-penha-a",
                    CurrentActionId = "act-penha-a3",
                    CurrentDispatchId = dispInem.Id,
                    UpdatedAt = now
                }
            }, ct);
        }

        log.LogInformation("Planos, ações, cortes de via e despachos operacionais semeados com sucesso.");
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
                CrewCapacity = 6,
                Capabilities = new() { VehicleCapability.CommandAndControl, VehicleCapability.Communications, VehicleCapability.Logistics },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 4,
                    UpdatedAt = now
                }
            });

            // VCOT - Veículo de Comando Operacional Tático 4x4
            list.Add(new Vehicle
            {
                Id = $"v-vcot-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VCOT {suffix}",
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

            // VETA - Veículo Especial de Telecomunicações e Apoio
            list.Add(new Vehicle
            {
                Id = $"v-veta-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VETA {suffix}",
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

            // VTTP - Veículo Tático de Transporte de Pessoal
            list.Add(new Vehicle
            {
                Id = $"v-vttp-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"VTTP {suffix}",
                Type = VehicleType.PersonnelTransport,
                TypeCode = "VTTP",
                CrewCapacity = 9,
                PassengerCapacity = 8,
                OffRoad = true,
                CruiseSpeedKmh = 110,
                Capabilities = new() { VehicleCapability.EvacuationTransport, VehicleCapability.Logistics },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 1,
                    UpdatedAt = now
                }
            });

            // AUTOCARRO - Autocarro de Evacuação de Populações
            list.Add(new Vehicle
            {
                Id = $"v-bus-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"AUTOCARRO {suffix}",
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
                    CrewOnboard = 1,
                    FuelPct = 100,
                    UpdatedAt = now
                }
            });

            // ABEV - Ambulância de Evacuação Múltipla / Transporte de Acamados
            list.Add(new Vehicle
            {
                Id = $"v-abev-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"ABEV {suffix}",
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
                    CrewOnboard = 2,
                    FuelPct = 90,
                    UpdatedAt = now
                }
            });

            // DRONE - Reconhecimento Térmico e Apoio à Evacuação
            list.Add(new Vehicle
            {
                Id = $"v-drone-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"DRONE {suffix}",
                Type = VehicleType.Drone,
                TypeCode = "DRONE",
                CrewCapacity = 2,
                MinimumCrew = 1,
                OffRoad = true,
                CruiseSpeedKmh = 80,
                RangeKm = 30,
                Capabilities = new() { VehicleCapability.AerialRecon, VehicleCapability.Reconnaissance },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 2,
                    FuelPct = 100,
                    UpdatedAt = now
                }
            });

            // AUTOCARRO 02 - Segundo autocarro de evacuação
            list.Add(new Vehicle
            {
                Id = $"v-bus2-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"AUTOCARRO 02",
                Type = VehicleType.Bus,
                TypeCode = "AUTOCARRO",
                CrewCapacity = 2,
                MinimumCrew = 1,
                PassengerCapacity = 50,
                OffRoad = false,
                CruiseSpeedKmh = 95,
                RangeKm = 850,
                FuelCapacityL = 280,
                Capabilities = new() { VehicleCapability.EvacuationTransport, VehicleCapability.Logistics },
                State = new()
                {
                    Status = VehicleStatus.Available,
                    Position = st.Position,
                    CrewOnboard = 1,
                    FuelPct = 95,
                    UpdatedAt = now
                }
            });

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

            // DRONE 02 - Reconhecimento Térmico Noturno
            list.Add(new Vehicle
            {
                Id = $"v-drone2-{idPrefix}",
                CreatedAt = now,
                UpdatedAt = now,
                OrganizationId = st.OrganizationId,
                StationId = st.Id,
                Callsign = $"DRONE 02",
                Type = VehicleType.Drone,
                TypeCode = "DRONE",
                CrewCapacity = 2,
                MinimumCrew = 1,
                OffRoad = true,
                CruiseSpeedKmh = 90,
                Capabilities = new() { VehicleCapability.AerialRecon, VehicleCapability.Reconnaissance },
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

        return list;
    }
}
