namespace FireTrace.Engine.Weather;

/// <summary>
/// A radiação solar à superfície (W/m²) por um sítio, uma hora e a nebulosidade. A posição do sol é a aproximação da NOAA (série de Fourier da declinação e da equação do tempo),
/// o céu limpo é o de Haurwitz (1945) e as nuvens atenuam como em Kasten e Czeplak (1980). Os coeficientes são os dos artigos.
/// </summary>
public static class SolarRadiation
{
    /// <summary>Elevação do sol acima do horizonte (radianos; negativa de noite).</summary>
    public static double ElevationRad(double latDeg, double lonDeg, DateTimeOffset time)
    {
        var utc = time.UtcDateTime;
        double hours = utc.Hour + utc.Minute / 60.0 + utc.Second / 3600.0;
        double g = 2 * Math.PI / 365 * (utc.DayOfYear - 1 + (hours - 12) / 24);
        double declination = 0.006918 - 0.399912 * Math.Cos(g) + 0.070257 * Math.Sin(g) - 0.006758 * Math.Cos(2 * g) + 0.000907 * Math.Sin(2 * g) - 0.002697 * Math.Cos(3 * g) + 0.00148 * Math.Sin(3 * g);
        double equationOfTimeMin = 229.18 * (0.000075 + 0.001868 * Math.Cos(g) - 0.032077 * Math.Sin(g) - 0.014615 * Math.Cos(2 * g) - 0.040849 * Math.Sin(2 * g));
        double solarMinutes = hours * 60 + equationOfTimeMin + 4 * lonDeg;
        double hourAngle = (solarMinutes / 4 - 180) * Math.PI / 180, lat = latDeg * Math.PI / 180;
        return Math.Asin(Math.Clamp(Math.Sin(lat) * Math.Sin(declination) + Math.Cos(lat) * Math.Cos(declination) * Math.Cos(hourAngle), -1, 1));
    }

    /// <summary>Radiação global com céu limpo (W/m²); zero de noite.</summary>
    public static double ClearSkyWm2(double latDeg, double lonDeg, DateTimeOffset time)
    {
        double cosZenith = Math.Sin(ElevationRad(latDeg, lonDeg, time));
        return cosZenith <= 0.01 ? 0 : 1098 * cosZenith * Math.Exp(-0.059 / cosZenith);
    }

    /// <summary>Radiação à superfície com a nebulosidade dada (0–100 %).</summary>
    public static double Wm2(double latDeg, double lonDeg, DateTimeOffset time, double cloudCoverPct) =>
        ClearSkyWm2(latDeg, lonDeg, time) * (1 - 0.75 * Math.Pow(Math.Clamp(cloudCoverPct, 0, 100) / 100, 3.4));
}
