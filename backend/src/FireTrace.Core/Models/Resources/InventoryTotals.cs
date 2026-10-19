using FireTrace.Core.Models.Map;

namespace FireTrace.Core.Models.Resources;

public sealed record InventoryTotals(IReadOnlyList<CountBreakdown> VehiclesByType, IReadOnlyList<CountBreakdown> VehiclesByStatus, IReadOnlyList<CountBreakdown> PersonnelByRole,
    IReadOnlyList<CountBreakdown> EquipmentByKind, IReadOnlyList<CountBreakdown> VehiclesByCapability, IReadOnlyList<ResponsibilityCount> DeploymentByResponsibility);
