import type { ProviderKind } from '@wow/contracts';
import { cn } from '@/lib/utils';
import { useModels } from './data';
import { effortOptions, modelOptions, permissionOptions } from './model';

export interface ThreadSettingsValue {
  readonly model: string;
  readonly effort: string;
  readonly permissionMode: string;
}

const selectClass =
  'h-7 max-w-44 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { readonly id: string; readonly label: string }[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={selectClass}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// Model, effort and permission mode pickers (spec 14, 17). The models come from the provider;
// a change applies to the next turn.
export function ThreadSettings({
  providerInstanceId,
  kind,
  value,
  disabled = false,
  className,
  onChange,
}: {
  providerInstanceId: string;
  kind: ProviderKind;
  value: ThreadSettingsValue;
  disabled?: boolean;
  className?: string;
  onChange(changes: Partial<ThreadSettingsValue>): void;
}) {
  const { models, error } = useModels(providerInstanceId);
  const modelChoices = modelOptions(models, value.model).map((id) => ({
    id,
    label: models.find((model) => model.id === id)?.label || id,
  }));
  const efforts = effortOptions(kind, models, value.model, value.effort).map((id) => ({
    id,
    label: id === 'default' ? 'Default effort' : id,
  }));
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <Select
        label="Model"
        value={value.model}
        options={modelChoices}
        disabled={disabled || modelChoices.length === 0}
        onChange={(model) => onChange({ model })}
      />
      <Select
        label="Effort"
        value={value.effort}
        options={efforts}
        disabled={disabled || efforts.length === 0}
        onChange={(effort) => onChange({ effort })}
      />
      <Select
        label="Permission mode"
        value={value.permissionMode}
        options={permissionOptions(kind, value.permissionMode)}
        disabled={disabled}
        onChange={(permissionMode) => onChange({ permissionMode })}
      />
      {error && (
        <span role="alert" className="text-xs text-destructive" title={error}>
          Models unavailable
        </span>
      )}
    </div>
  );
}
