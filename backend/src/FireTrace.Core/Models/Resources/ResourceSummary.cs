namespace FireTrace.Core.Models.Resources;

public sealed record ResourceSummary(string LocationId, DateTimeOffset AsOf, IReadOnlyList<ResourceSummaryEntry> Organizations, InventoryTotals Overall);
