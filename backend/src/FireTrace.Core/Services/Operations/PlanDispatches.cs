using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans.Triggers;

namespace FireTrace.Core.Services.Operations;

/// <summary>
/// Os despachos que a ativação de um plano cria: um por viatura e um por grupo de pessoal, não um por cada tarefa. Um plano usa o mesmo meio em tarefas que se
/// seguem (uma equipa ataca e depois fica em prontidão; um grupo evacua e depois ataca, quando a evacuação acaba): são um só despacho, para a primeira tarefa, e o
/// grupo cede as pessoas que as suas tarefas pedem ao mesmo tempo (o máximo, não a soma). Esperar (estacionar, reserva, prontidão) acaba quando chega a ordem
/// seguinte do mesmo meio; e uma viatura só está num sítio: uma ordem dada mais tarde muda-lhe a tarefa (o que fazia acaba aí). Tarefas da mesma viatura que
/// começam ao mesmo tempo não se juntam: ficam
/// despachos à parte, e o despacho recusa-as por estarem repetidas; num grupo somam-se, e o despacho recusa se não houver gente que chegue. Um conflito real
/// continua a bloquear a ativação.
/// </summary>
public static class PlanDispatches
{
    /// <summary>Folga entre o fim de uma tarefa e o início da seguinte (os agentes arredondam o início da seguinte ao minuto).</summary>
    const double SameMinute = 1;

    /// <summary>
    /// Os despachos de `plan`: para cada um, a ação de onde parte, a atribuição (com as pessoas a levar) e quanto tempo o meio fica até acabar a última tarefa.
    /// `defaultPersonnel` dá as pessoas de uma viatura cuja atribuição não as indica (a tripulação a bordo, não uma pessoa).
    /// </summary>
    public static List<(PlanAction Action, ResourceAssignment Resource, int StayMinutes)> Build(Plan plan, int defaultWindowMinutes, Func<ResourceAssignment, int?> defaultPersonnel)
    {
        var windows = Windows(plan, defaultWindowMinutes);
        var jobs = plan.Actions
            .SelectMany(a => (a.Resources ?? new()).Where(r => r.ResourceType != ResourceType.Equipment).Select(r =>
            {
                double start = windows[a.Id].Start, eta = Math.Max(0, r.EtaMinutes ?? 0);
                return (Action: a, Resource: r, Start: start, Eta: eta, End: start + eta + Duration(a, defaultWindowMinutes));
            }))
            .ToList();
        var result = new List<(PlanAction, ResourceAssignment, int)>();
        foreach (var unit in jobs.GroupBy(j => (j.Resource.ResourceType, j.Resource.ResourceId)))
        {
            var ordered = unit.OrderBy(j => j.Start).ThenBy(j => j.End).ToList();
            // waiting (a staging area, a reserve, holding after a job) starts once the work before it is done (a hold timed a minute early is not a second job)...
            for (int i = 1; i < ordered.Count; i++)
                if (ordered[i].Action is StageResourcesAction && ordered.Take(i).Where(j => j.Action is not StageResourcesAction).Select(j => j.End).DefaultIfEmpty(0).Max() is var busy && busy > ordered[i].Start)
                    ordered[i] = ordered[i] with { Start = Math.Min(busy, ordered[i].End), End = Math.Max(busy, ordered[i].End) };
            ordered = ordered.OrderBy(j => j.Start).ThenBy(j => j.End).ToList();
            // ...and ends when the unit's next order starts: the reserve is drawn on, the hold is over
            for (int i = 0; i + 1 < ordered.Count; i++)
                if (ordered[i].Action is StageResourcesAction)
                    ordered[i] = ordered[i] with { End = Math.Min(ordered[i].End, Math.Max(ordered[i].Start, ordered[i + 1].Start)) };
            if (unit.Key.ResourceType == ResourceType.PersonnelPool)
            {
                // the most people the group's tasks need at the same moment: tasks that follow each other share them, tasks at the same time add up
                int peak = 0, now = 0;
                foreach (var (_, delta) in ordered.SelectMany(j => new[] { (At: j.Start, Delta: j.Resource.Personnel ?? 1), (At: j.End - SameMinute, Delta: -(j.Resource.Personnel ?? 1)) })
                             .OrderBy(e => e.At).ThenBy(e => e.Delta))
                    peak = Math.Max(peak, now += delta);
                var first = ordered[0];
                result.Add((first.Action, first.Resource with { Personnel = peak }, Stay(first.Start, first.Eta, ordered.Max(j => j.End))));
                continue;
            }
            // a vehicle is in one place at a time: an order given later re-tasks it (a re-planning wave redirects a crew on the road, or moves it off a quiet
            // stretch), and what it was doing ends when that order starts. Two orders at the same moment stay a conflict.
            for (int i = 0; i + 1 < ordered.Count; i++)
            {
                var later = ordered.Skip(i + 1).FirstOrDefault(j => j.Start > ordered[i].Start + SameMinute);
                if (later.Action is not null) ordered[i] = ordered[i] with { End = Math.Min(ordered[i].End, later.Start) };
            }
            // the tasks it chains (each starts when the one before has ended) are one dispatch; one that overlaps the chain stays apart (a real conflict)
            var chain = new List<(PlanAction Action, ResourceAssignment Resource, double Start, double Eta, double End)> { ordered[0] };
            foreach (var job in ordered.Skip(1))
            {
                if (job.Start >= chain.Max(j => j.End) - SameMinute) chain.Add(job);
                else result.Add((job.Action, job.Resource with { Personnel = job.Resource.Personnel ?? defaultPersonnel(job.Resource) }, Stay(job.Start, job.Eta, job.End)));
            }
            var head = chain[0];
            int? personnel = chain.Select(j => j.Resource.Personnel).Max() ?? defaultPersonnel(head.Resource);
            result.Add((head.Action, head.Resource with { Personnel = personnel }, Stay(head.Start, head.Eta, chain.Max(j => j.End))));
        }
        return result;
    }

    /// <summary>
    /// Quando começa e acaba cada ação (minutos desde o início do plano): o gatilho de hora, ou o fim da ação de que depende (`on_action_complete` e `dependsOn`),
    /// mais a viagem do meio mais longe e a duração prevista.
    /// </summary>
    public static Dictionary<string, (double Start, double End)> Windows(Plan plan, int defaultWindowMinutes)
    {
        var byId = plan.Actions.GroupBy(a => a.Id).ToDictionary(g => g.Key, g => g.First());
        var memo = new Dictionary<string, (double Start, double End)>();
        var visiting = new HashSet<string>();

        (double Start, double End) Of(PlanAction a)
        {
            if (memo.TryGetValue(a.Id, out var known)) return known;
            if (!visiting.Add(a.Id)) return (0, 0); // a dependency cycle (validation refuses it): count from activation
            double start = a.Trigger is OnActionCompleteTrigger done && byId.TryGetValue(done.ActionId, out var before) ? Of(before).End : PlanTiming.StartMinutes(plan, a);
            foreach (var id in a.DependsOn ?? new())
                if (byId.TryGetValue(id, out var dependency)) start = Math.Max(start, Of(dependency).End);
            double eta = (a.Resources ?? new()).Select(r => Math.Max(0, r.EtaMinutes ?? 0)).DefaultIfEmpty(0).Max();
            visiting.Remove(a.Id);
            return memo[a.Id] = (start, start + eta + Duration(a, defaultWindowMinutes));
        }

        foreach (var a in byId.Values) Of(a);
        return memo;
    }

    static double Duration(PlanAction a, int defaultWindowMinutes) => Math.Max(1, a.ExpectedDurationMinutes ?? defaultWindowMinutes);

    /// <summary>The stay at the first task's target, from arrival to the end of the last task.</summary>
    static int Stay(double start, double eta, double end) => Math.Max(1, (int)Math.Ceiling(end - start - eta));
}
