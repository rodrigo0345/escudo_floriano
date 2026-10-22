import { useMemo, useRef, useState } from 'react';

import { plansApi, type Action, type Plan, type PlanInput, type PlanValidation, type ResourceAssignment, type Simulation } from '@/api';
import { Tag } from '@/components/common/StatCard';
import {
  actionCentre,
  addVehicleAssignment,
  addVehicleSuggestions,
  effectWindows,
  hasNoResources,
  removeAction,
  removeAssignment,
  responsibilityFor,
  setTriggerMinute,
  shiftAction,
  suggestVehicles,
  triggerKind,
  triggerStartMinute,
  updateAssignment,
} from '@/domain/planEdit';
import { useResourcesStore } from '@/store/resourcesStore';
import { useAppStore } from '@/store/appStore';

import styles from './panels.module.css';

interface PlanEditorProps {
  plan: Plan;
  baseId: string;
  orgName: (organizationId: string) => string;
  onCancel: () => void;
  onSaved: (plan: Plan, simulation: Simulation) => void;
  onError: (message: string) => void;
}

const ASSIGNMENT_TYPE_LABEL: Record<string, string> = {
  vehicle: 'viatura',
  personnel_pool: 'pessoal',
  equipment: 'equipamento',
};

const issueKind = (severity: string): 'ok' | 'warn' | 'bad' => (severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : 'ok');

/**
 * The operator adjusts an agent plan instead of building one (Epic A6): remove an action or a vehicle, move the target on the map,
 * change the minute it starts. The edited plan goes through `POST /plans/validate` first and is saved with `PATCH /plans/{id}`
 * (merge-patch, `actions` replaced as a whole), then re-simulated, so the plan next to A and B always has a what-if that matches it.
 */
export function PlanEditor({ plan, baseId, orgName, onCancel, onSaved, onError }: PlanEditorProps) {
  const startMs = useAppStore((s) => s.run?.startMs);
  const vehicles = useResourcesStore((s) => s.vehicles);
  const organizations = useResourcesStore((s) => s.organizations);
  const [title, setTitle] = useState(plan.title);
  const [actions, setActions] = useState<Action[]>(() => JSON.parse(JSON.stringify(plan.actions ?? [])) as Action[]);
  // A ref as well as state: an edit made in an input's `onBlur` must be the one the button's `onClick` sends, even if React has not
  // re-rendered between the two discrete events.
  const actionsRef = useRef(actions);
  const [validation, setValidation] = useState<PlanValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'validar' | 'gravar' | 'simular' | null>(null);

  const orgOf = useMemo(() => new Map(organizations.map((o) => [o.id as string, o.name])), [organizations]);
  const vehicleOf = useMemo(() => new Map(vehicles.map((v) => [v.id as string, v])), [vehicles]);

  const input = (): PlanInput => ({
    locationId: plan.locationId,
    title: title.trim() || plan.title,
    variant: plan.variant,
    strategy: plan.strategy,
    summary: plan.summary,
    basis: plan.basis,
    objectives: plan.objectives,
    alertLevel: plan.alertLevel,
    horizon: plan.horizon,
    actions: actionsRef.current,
    assumptions: plan.assumptions,
    risks: plan.risks,
    confidence: plan.confidence,
    tags: plan.tags,
    metadata: plan.metadata,
  });

  const edit = (index: number, next: Action) => {
    setValidation(null);
    actionsRef.current = actionsRef.current.map((action, i) => (i === index ? next : action));
    setActions(actionsRef.current);
  };

  const validate = async (): Promise<PlanValidation | null> => {
    setBusy('validar');
    setError(null);
    try {
      const result = await plansApi.validate(input());
      setValidation(result);
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('gravar');
    setError(null);
    try {
      const check = await plansApi.validate(input());
      setValidation(check);
      if (!check.valid) {
        setBusy(null);
        return;
      }
      const updated = await plansApi.patch(plan.id as string, {
        actions: actionsRef.current,
        title: title.trim() || plan.title,
        metadata: { ...(plan.metadata ?? {}), 'operator.editedAt': new Date().toISOString(), 'operator.editedBy': 'operator' },
      });
      setBusy('simular');
      const simulation = await plansApi.simulateAndWait(plan.id as string, baseId);
      onSaved(updated, simulation);
    } catch (e) {
      setError((e as Error).message);
      onError(`Plano ajustado: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const label = plan.variant ?? plan.title;

  return (
    <div className={styles.planEditor}>
      <div className={styles.editorHead}>
        <div>
          <h3 style={{ margin: 0 }}>Ajustar plano {label}</h3>
          <small className="note">As alterações substituem as ações deste plano e o what-if é recalculado (o plano fica marcado como ajustado ′); o outro plano do par mantém-se.</small>
        </div>
        <button className={styles.linkButton} onClick={onCancel} aria-label="Fechar editor">
          Fechar
        </button>
      </div>

      <label className={styles.editorField}>
        <span>Título</span>
        <input value={title} onChange={(e) => { setTitle(e.target.value); setValidation(null); }} />
      </label>

      <div className={styles.editorActions}>
        {actions.map((action, index) => {
          const centre = actionCentre(action);
          const resources = (action.resources ?? []) as ResourceAssignment[];
          const assigned = new Set(resources.map((r) => `${r.resourceType}:${r.resourceId}`));
          // Suggestions never propose a vehicle another action of this plan already carries (the validator raises
          // `resource_conflict`); the manual dropdown still lists everything not on THIS action, for deliberate sequential reuse.
          const usedIds = new Set(
            actions.flatMap((a) => ((a.resources ?? []) as ResourceAssignment[]).map((r) => `${r.resourceType}:${r.resourceId}`)),
          );
          const choices = vehicles.filter((v) => !assigned.has(`vehicle:${v.id}`));
          const windows = effectWindows(action, startMs);
          // Every handler reads the ref: two quick edits must compose, not overwrite each other from a stale render closure.
          const mutate = (fn: (current: Action) => Action) => {
            const current = actionsRef.current[index];
            if (current) edit(index, fn(current));
          };
          const now = () => actionCentre(actionsRef.current[index]);
          return (
            <div key={(action.id as string) ?? index} className={styles.editorAction}>
              <div className={styles.editorActionHead}>
                <span className={styles.editorActionTitle}>
                  <b>{action.title ?? action.type ?? `Ação ${index + 1}`}</b>
                  <small className="note">
                    {action.type} · {orgName(action.organizationId ?? '') || orgOf.get(action.organizationId ?? '') || '—'} · início {triggerKind(action)}
                  </small>
                </span>
                <button className={styles.linkButton} onClick={() => { setValidation(null); actionsRef.current = removeAction(actionsRef.current, index); setActions(actionsRef.current); }}>
                  Remover ação
                </button>
              </div>

              <div className={styles.editorGrid}>
                <label className={styles.editorField}>
                  <span>Começa a T+ (min)</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={triggerStartMinute(action, startMs) ?? 0}
                    onChange={(e) => mutate((current) => setTriggerMinute(current, Number(e.target.value) || 0, startMs))}
                  />
                  {triggerStartMinute(action, startMs) == null && triggerKind(action) !== 'imediato' ? (
                    <small className="note">Gatilho condicional convertido em hora: o motor só simula `at_time`.</small>
                  ) : null}
                </label>

                {centre ? (
                  <>
                    <label className={styles.editorField}>
                      <span>Alvo — latitude</span>
                      <input
                        type="number"
                        step="0.0001"
                        defaultValue={centre.lat.toFixed(5)}
                        onBlur={(e) => {
                          const lat = Number(e.target.value);
                          const at = now();
                          if (Number.isFinite(lat) && at) mutate((current) => shiftAction(current, lat - at.lat, 0));
                        }}
                      />
                    </label>
                    <label className={styles.editorField}>
                      <span>Alvo — longitude</span>
                      <input
                        type="number"
                        step="0.0001"
                        defaultValue={centre.lon.toFixed(5)}
                        onBlur={(e) => {
                          const lon = Number(e.target.value);
                          const at = now();
                          if (Number.isFinite(lon) && at) mutate((current) => shiftAction(current, 0, lon - at.lon));
                        }}
                      />
                    </label>
                  </>
                ) : (
                  <small className="note">Esta ação não tem um alvo no mapa para mover.</small>
                )}
              </div>

              <div className={styles.editorResources}>
                <small className="note">Meios atribuídos ({resources.length})</small>
                {hasNoResources(action) ? (
                  <small className={styles.emptyMeans}>
                    Os agentes não atribuíram meios a esta ação (comum nos planos de demonstração e nos pedidos sem frota).
                    Usa <b>Sugerir meios</b> ou escolhe viaturas abaixo.
                  </small>
                ) : null}
                <button
                  className={styles.suggestButton}
                  onClick={() => mutate((current) => addVehicleSuggestions(current, suggestVehicles(current, vehicles, usedIds), responsibilityFor(current)))}
                >
                  Sugerir meios
                </button>
                {resources.map((resource, j) => {
                  const vehicle = vehicleOf.get(resource.resourceId as string);
                  return (
                    <div key={`${resource.resourceType}:${resource.resourceId}:${j}`} className={styles.editorResource}>
                      <span>
                        {vehicle?.callsign ?? resource.resourceId}
                        <small className="note">
                          {' '}
                          {ASSIGNMENT_TYPE_LABEL[resource.resourceType] ?? resource.resourceType}
                          {resource.responsibility ? ` · ${resource.responsibility}` : ''}
                        </small>
                      </span>
                      {resource.resourceType === 'vehicle' ? (
                        <label className={styles.inlineField}>
                          <span>pessoas</span>
                          <input
                            type="number"
                            min={1}
                            value={resource.personnel ?? 1}
                            onChange={(e) => mutate((current) => updateAssignment(current, j, { personnel: Math.max(1, Number(e.target.value) || 1) }))}
                          />
                        </label>
                      ) : null}
                      <button className={styles.linkButton} onClick={() => mutate((current) => removeAssignment(current, j))}>
                        Retirar
                      </button>
                    </div>
                  );
                })}
                <select
                  value=""
                  onChange={(e) => {
                    const vehicle = vehicleOf.get(e.target.value);
                    if (vehicle) mutate((current) => addVehicleAssignment(current, vehicle, responsibilityFor(current)));
                  }}
                >
                  <option value="">Adicionar viatura…</option>
                  {choices.map((v) => (
                    <option key={v.id as string} value={v.id as string}>
                      {v.callsign} · {orgOf.get(v.organizationId as string) ?? orgName(v.organizationId as string)} · {v.type}
                    </option>
                  ))}
                </select>
              </div>

              {windows.length ? (
                <small className="note">
                  No motor: {windows.map((w) => `T+${w.start}–${w.end}`).join(' · ')}
                </small>
              ) : null}
            </div>
          );
        })}
      </div>

      {actions.length === 0 ? <p className="note">O plano ficaria sem ações. O servidor aceita-o, mas não faz nada; adicione pelo menos uma ação ou cancele.</p> : null}

      {validation ? (
        <div className={styles.editorIssues}>
          <b>Validação: {validation.valid ? 'sem erros' : 'há erros'}</b>
          {validation.issues.length === 0 ? <small className="note">Nada a assinalar.</small> : null}
          {validation.issues.map((issue, i) => (
            <div key={`${issue.code}:${i}`} className={styles.editorIssue}>
              <Tag kind={issueKind(issue.severity)}>{issue.severity}</Tag>
              <span>{issue.message}</span>
              {issue.pointer ? <small className="note">{issue.pointer}</small> : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="note">Erro: {error}</p> : null}

      <div className={styles.two}>
        <button disabled={!!busy} onClick={() => void validate()}>
          {busy === 'validar' ? 'A validar…' : 'Validar'}
        </button>
        <button disabled={!!busy} onClick={() => void save()}>
          {busy === 'gravar' ? 'A gravar…' : busy === 'simular' ? 'A simular o ajuste…' : 'Gravar e simular'}
        </button>
      </div>
    </div>
  );
}
