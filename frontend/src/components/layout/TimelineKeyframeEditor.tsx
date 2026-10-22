import { Icon } from '@/components/common/Icon';
import type { TimelineKeyframe } from '@/domain/simulationForm';

import styles from './layout.module.css';

interface Props {
  keyframe: TimelineKeyframe;
  maxMinute: number;
  onChange: (patch: Partial<TimelineKeyframe>) => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * Popover for one sparse curve point (`WeatherSpec.keyframes`). Every field can be left blank:
 * blank means "keep following the provider series / the previous point" at that instant.
 */
export function TimelineKeyframeEditor({ keyframe, maxMinute, onChange, onDelete, onClose }: Props) {
  const number = (key: keyof TimelineKeyframe, label: string, min: number, max: number, step: number) => (
    <label className={styles.popoverField}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={keyframe[key] == null ? '' : (keyframe[key] as number)}
        placeholder="base"
        onChange={(e) =>
          onChange({ [key]: e.target.value === '' ? undefined : Math.max(min, Math.min(max, +e.target.value)) } as Partial<TimelineKeyframe>)
        }
      />
    </label>
  );

  return (
    <>
      <div className={styles.popoverHead}>
        <span>Ponto-chave T+{keyframe.minute} min</span>
        <button className={styles.popoverClose} onClick={onClose} title="Fechar" aria-label="Fechar">
          <Icon name="close" />
        </button>
      </div>

      <div className={styles.rangeInputs}>
        <label>
          T+
          <input
            type="number"
            min={0}
            max={maxMinute}
            step={5}
            value={keyframe.minute}
            onChange={(e) => onChange({ minute: Math.max(0, Math.min(maxMinute, +e.target.value || 0)) })}
          />
          min
        </label>
        <label>
          Transição
          <select
            value={keyframe.transition ?? 'linear'}
            onChange={(e) => onChange({ transition: e.target.value as TimelineKeyframe['transition'] })}
          >
            <option value="linear">linear</option>
            <option value="smooth">suave</option>
            <option value="step">degrau</option>
          </select>
        </label>
      </div>

      <label className={styles.popoverField}>
        <span>Rótulo</span>
        <input
          type="text"
          value={keyframe.label ?? ''}
          placeholder="ex.: frente fria chega"
          onChange={(e) => onChange({ label: e.target.value || undefined })}
        />
      </label>

      <div className={styles.kfGrid}>
        {number('windKmh', 'Vento (km/h)', 0, 200, 1)}
        {number('windFromDeg', 'Vento de (°)', 0, 360, 5)}
        {number('gustKmh', 'Rajada (km/h)', 0, 300, 1)}
        {number('tempC', 'Temperatura (°C)', -20, 60, 0.5)}
        {number('humidityPct', 'Humidade (%)', 1, 100, 1)}
        {number('precipitationMmH', 'Chuva (mm/h)', 0, 200, 0.5)}
        {number('cloudCoverPct', 'Nuvens (%)', 0, 100, 5)}
      </div>

      <div className={styles.popoverNote}>
        Um campo vazio continua a seguir a série base (ou o ponto anterior) nesse instante. Os pontos são aplicados pela ordem do tempo.
      </div>

      <div className={styles.popoverActions}>
        <button type="button" className={styles.btnDelete} onClick={onDelete}>
          Remover ponto
        </button>
      </div>
    </>
  );
}
