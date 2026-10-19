namespace FireTrace.Core.Models.Weather;

public sealed record EnsemblePreview(IReadOnlyList<double> WindKmhP10, IReadOnlyList<double> WindKmhP90, double WindFromDegSigma);
