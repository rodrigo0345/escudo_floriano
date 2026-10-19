namespace FireTrace.Engine.Weather;

public static class Angles
{
    public static double Normalize(double deg) => (deg % 360 + 360) % 360;

    /// <summary>Interpola entre dois rumos. `mode`: <c>shortest_arc</c> (por omissão), <c>clockwise</c> ou <c>counter_clockwise</c>.</summary>
    public static double Lerp(double from, double to, double f, string mode = "shortest_arc")
    {
        double d = Normalize(to - from);                 // sentido horário, 0..360
        if (mode == "counter_clockwise") d -= d == 0 ? 0 : 360;
        else if (mode != "clockwise" && d > 180) d -= 360;
        return Normalize(from + d * f);
    }
}
