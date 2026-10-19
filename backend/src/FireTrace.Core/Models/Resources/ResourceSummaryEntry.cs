using FireTrace.Core.Domain.Resources;

namespace FireTrace.Core.Models.Resources;

public sealed record ResourceSummaryEntry(string OrganizationId, string? OrganizationName, OrganizationType OrganizationType, InventoryTotals Totals);
