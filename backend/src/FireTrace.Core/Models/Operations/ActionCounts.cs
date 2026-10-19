using System.Text.Json;
using System.Text.RegularExpressions;

namespace FireTrace.Core.Models.Operations;

public sealed record ActionCounts(int Total, int Completed, int InProgress, int Blocked);
