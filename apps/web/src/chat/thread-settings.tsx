import type { ProviderKind } from '@wow/contracts';
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useModels } from './data';
import { effortOptions, modelOptions, permissionOptions } from './model';
import { effortLabel } from './view-model';

export interface ThreadSettingsValue {
  readonly model: string;
  readonly effort: string;
  readonly permissionMode: string;
}

// A compact select whose trigger reads "Model: Mock model", so a toolbar of selects says which
// is which (audit A-05, C-08). The list shows the values only.
function Select({
  label,
  name = label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  // The accessible name, when it says more than the short visible label.
  name?: string;
  value: string;
  options: readonly { readonly id: string; readonly label: string }[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  const known = options.some((option) => option.id === value);
  return (
    <SelectRoot value={known ? value : ''} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        aria-label={name}
        size="sm"
        className="w-auto max-w-72 gap-1 text-xs data-[size=sm]:h-7"
      >
        <span aria-hidden className="text-muted-foreground">
          {label}:
        </span>
        <SelectValue placeholder={value || 'None'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

const marked = (label: string, isDefault: boolean) => (isDefault ? `${label} (default)` : label);

// Model, effort and permission mode pickers (spec 14, 17). The models come from the provider;
// a change applies to the next turn.
export function ThreadSettings({
  providerInstanceId,
  kind,
  value,
  defaults,
  disabled = false,
  className,
  onChange,
}: {
  providerInstanceId: string;
  kind: ProviderKind;
  value: ThreadSettingsValue;
  // The instance's defaults, marked in the lists (questions and models spec 18).
  defaults?: { readonly model: string | null; readonly effort: string | null };
  disabled?: boolean;
  className?: string;
  onChange(changes: Partial<ThreadSettingsValue>): void;
}) {
  const { models, error } = useModels(providerInstanceId);
  const modelChoices = modelOptions(models, value.model).map((id) => ({
    id,
    label: marked(models.find((model) => model.id === id)?.label || id, id === defaults?.model),
  }));
  const efforts = effortOptions(kind, models, value.model, value.effort).map((id) => ({
    id,
    label: marked(effortLabel(id), id === defaults?.effort),
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
        label="Permissions"
        name="Permission mode"
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
