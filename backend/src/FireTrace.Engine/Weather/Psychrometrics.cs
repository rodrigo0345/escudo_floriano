namespace FireTrace.Engine.Weather;

/// <summary>Relações entre temperatura e humidade do ar (fórmula de Magnus, 17,62 / 243,12 °C: coeficientes da fórmula).</summary>
public static class Psychrometrics
{
    const double A = 17.62, B = 243.12;

    /// <summary>Pressão de vapor de saturação (hPa) a uma temperatura (°C).</summary>
    public static double SaturationHpa(double tempC) => 6.112 * Math.Exp(A * tempC / (B + tempC));

    /// <summary>Temperatura do ponto de orvalho (°C) para uma temperatura e humidade relativa (%).</summary>
    public static double DewPointC(double tempC, double humidityPct)
    {
        double g = Math.Log(Math.Clamp(humidityPct, 1, 100) / 100) + A * tempC / (B + tempC);
        return B * g / (A - g);
    }

    /// <summary>
    /// Humidade relativa (%) junto a uma superfície mais quente que o ar: o mesmo vapor de água, mas a saturação sobe com a temperatura, por isso a humidade desce.
    /// </summary>
    public static double SurfaceHumidityPct(double airHumidityPct, double airTempC, double surfaceTempC) =>
        Math.Clamp(airHumidityPct * SaturationHpa(airTempC) / SaturationHpa(surfaceTempC), 1, 100);
}
