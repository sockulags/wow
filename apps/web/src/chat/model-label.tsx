import type { ProviderModel } from '@wow/contracts';
import { WithTooltip } from '@/components/hint';
import { useModels } from './data';

// A model is named by the label its provider gives it; the id stays in a tooltip (agent
// workbench spec 86). Before the provider has listed its models, or for a model it no longer
// lists, the id is all there is.
export const modelLabel = (models: readonly Pick<ProviderModel, 'id' | 'label'>[], id: string) =>
  models.find((model) => model.id === id)?.label || id;

export function useModelLabel(providerInstanceId: string | undefined, id: string): string {
  const { models } = useModels(providerInstanceId);
  return modelLabel(models, id);
}

// `plain` is for a place that is itself a control (the builder's step header is a button), where
// a focusable tooltip trigger cannot sit; the browser's own tooltip shows the id there.
export function ModelName({
  providerInstanceId,
  model,
  plain = false,
  className,
}: {
  readonly providerInstanceId: string | undefined;
  readonly model: string;
  readonly plain?: boolean;
  readonly className?: string | undefined;
}) {
  const label = useModelLabel(providerInstanceId, model);
  if (plain) {
    return (
      <span data-testid="model-name" data-model-id={model} title={model} className={className}>
        {label}
      </span>
    );
  }
  return (
    <WithTooltip label={model}>
      <span
        tabIndex={0}
        data-testid="model-name"
        data-model-id={model}
        aria-label={label === model ? `Model ${model}` : `Model ${label} (${model})`}
        className={className}
      >
        {label}
      </span>
    </WithTooltip>
  );
}
