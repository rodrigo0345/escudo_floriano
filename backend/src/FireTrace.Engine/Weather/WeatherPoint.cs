namespace FireTrace.Engine.Weather;

/// <summary>Um instante da meteorologia de uma simulação, em minutos desde o início (negativos = período de aquecimento).</summary>
public sealed record WeatherPoint(double Minute, double WindKmh, double WindFromDeg, double HumidityPct, double TempC, double GustKmh = 0, double PrecipitationMmH = 0, double CloudCoverPct = 0, double SolarRadiationWm2 = 0,
    double? VisibilityM = null, double? CapeJkg = null, bool? IsDay = null);
