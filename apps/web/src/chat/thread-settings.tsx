import type { ProviderKind, ProviderModel } from '@wow/contracts';
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

export interface ModelDefaults {
  readonly model: string | null;
  readonly effort: string | null;
}

// One row of the model list (agent workbench spec 7): the label, the provider's description,
// "(default)" on the instance's default, and whether the provider says the model takes images.
// While the instance names no default, the model the provider flags as its own default is
// marked as the provider's. A field the provider does not report stays undefined.
export interface ModelChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly isDefault: boolean;
  readonly providerDefault: boolean;
  readonly imageInput: boolean | undefined;
}

export function modelChoices(
  models: readonly ProviderModel[],
  current: string,
  defaults: ModelDefaults | undefined,
): ModelChoice[] {
  const instanceDefault = defaults?.model || undefined;
  return modelOptions(models, current).map((id) => {
    const model = models.find((candidate) => candidate.id === id);
    return {
      id,
      label: model?.label || id,
      description: model?.description ?? '',
      isDefault: id === instanceDefault,
      providerDefault: instanceDefault === undefined && model?.isDefault === true,
      imageInput: model?.imageInput,
    };
  });
}

// One row of the effort list (spec 8): the chosen model's own levels; "(default)" on the
// instance's default, and the model's own default level where the provider names one.
export interface EffortChoice {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly isModelDefault: boolean;
}

export function effortChoices(
  kind: ProviderKind,
  models: readonly ProviderModel[],
  model: string,
  current: string,
  defaults: ModelDefaults | undefined,
): EffortChoice[] {
  const own = models.find((candidate) => candidate.id === model)?.defaultEffort;
  return effortOptions(kind, models, model, current).map((id) => ({
    id,
    label: effortLabel(id),
    isDefault: id === defaults?.effort,
    isModelDefault: id === own,
  }));
}

// The text a plain list shows for a choice (the builder's selects).
export const modelChoiceText = (choice: ModelChoice): string =>
  choice.isDefault
    ? `${choice.label} (default)`
    : choice.providerDefault
      ? `${choice.label} (provider's default)`
      : choice.label;

export const effortChoiceText = (choice: EffortChoice): string =>
  [
    choice.label,
    ...(choice.isDefault ? [' (default)'] : []),
    ...(choice.isModelDefault ? [" (model's default)"] : []),
  ].join('');

// Model, effort and permission mode selects, kept by the workflow builder (agent workbench U1:
// threads pick them in the composer bar instead). The lists are the bar's. The models come from
// the provider; a change applies to the next turn.
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
  defaults?: ModelDefaults;
  disabled?: boolean;
  className?: string;
  onChange(changes: Partial<ThreadSettingsValue>): void;
}) {
  const { models, error } = useModels(providerInstanceId);
  const modelList = modelChoices(models, value.model, defaults).map((choice) => ({
    id: choice.id,
    label: modelChoiceText(choice),
  }));
  const efforts = effortChoices(kind, models, value.model, value.effort, defaults).map(
    (choice) => ({ id: choice.id, label: effortChoiceText(choice) }),
  );
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <Select
        label="Model"
        value={value.model}
        options={modelList}
        disabled={disabled || modelList.length === 0}
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
