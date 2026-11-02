import type { ProviderInstance } from '@wow/contracts';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { statusLabels } from './model';

// The stored result of the instance's last "Test"; the server writes it, the badge only shows it.
export function StatusBadge({ instance }: { instance: ProviderInstance }) {
  return (
    <Badge
      variant="outline"
      data-testid="provider-status"
      className={cn(
        instance.status === 'ready' && 'border-state-done/50 text-state-done',
        instance.status === 'error' && 'border-state-failed/50 text-state-failed',
        instance.status === 'unknown' && 'border-warning/50 text-warning',
      )}
    >
      {statusLabels[instance.status]}
    </Badge>
  );
}
