namespace FireTrace.ExternalData.Configuration;

public sealed record WaterwayOptions(string[] BarrierKinds, Dictionary<string, string> OsmWaterwayTags, Dictionary<string, double> DefaultWidthM);
