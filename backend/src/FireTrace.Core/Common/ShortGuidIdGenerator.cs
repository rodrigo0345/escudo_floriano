namespace FireTrace.Core.Common;

public sealed class ShortGuidIdGenerator : IIdGenerator
{
    public string New(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..(prefix.Length + 11)];
}
